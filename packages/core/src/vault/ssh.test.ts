/** SSH keys in the Vault (docs/decisions/vault.md VT-S01…VT-S13, contracts 0.32.0): the pure rules. */
import { describe, expect, it } from 'vitest';
import { MCP_TOOLS } from '../contracts/mcp.js';
import { VaultContextSshServer } from '../contracts/vault.js';
import {
  base64ToBytes,
  bytesToBase64,
  holdsVaultSshKey,
  inspectVaultSshPrivateKey,
  parseVaultSshHost,
  parseVaultSshPorts,
  parseVaultSshPublicKey,
  VAULT_FAILURE_TEXT,
  VAULT_SSH_ADDRESS_NOT_ALLOWED_ANY_MORE,
  VAULT_SSH_COPY,
  VAULT_SSH_KEY_PROBLEM_TEXT,
  VAULT_TEMPLATE_DEFS,
  VaultAuth,
  VaultEntryDetail,
  VaultKeyView,
  VaultSshHost,
  VaultSshServer,
  VaultSshServerName,
  VaultSshUsername,
  VaultUse,
  vaultCheckSummary,
  vaultEntryKey,
  vaultEntryLabel,
  vaultEntryMeta,
  vaultEntryShapeProblems,
  vaultEntryWhere,
  vaultKeyCoveredServers,
  vaultKeyCoversServer,
  vaultKeyServersText,
  vaultSshAuthorizedKeysLine,
  vaultSshCheckStatus,
  vaultSshCheckSummary,
  vaultSshDestinationProblem,
  vaultSshEntryCheck,
  vaultSshFingerprint,
  vaultSshHostKeyFile,
  vaultSshHostKeyLabel,
  vaultSshKeyForms,
  vaultSshPrivateKeyLines,
  vaultSshServerCheckLine,
  vaultSshServerReady,
  vaultSshServerTarget,
  vaultSshTrustCopy,
  vaultSshTrustQuestion,
  vaultTemplateOf,
  vaultUseRow,
} from './index.js';

/** TEST ONLY: a throwaway ed25519 pair made for these tests (`ssh-keygen -t ed25519 -C test`). */
const ED25519_PRIVATE = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACCwZq1awEVKk2HwcTa8vgxxCflRpEQLH1vItHbhu28L+QAAAIibQrhum0K4
bgAAAAtzc2gtZWQyNTUxOQAAACCwZq1awEVKk2HwcTa8vgxxCflRpEQLH1vItHbhu28L+Q
AAAECq5lZhxOthCAsMc3+7yD+sGL5dQ6MnR2zxpf5kgTmIdrBmrVrARUqTYfBxNry+DHEJ
+VGkRAsfW8i0duG7bwv5AAAABHRlc3QB
-----END OPENSSH PRIVATE KEY-----
`;
const ED25519_PUBLIC = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILBmrVrARUqTYfBxNry+DHEJ+VGkRAsfW8i0duG7bwv5';
/** `ssh-keygen -lf` of the pair above. */
const ED25519_FINGERPRINT = 'SHA256:zibNZfkJQ795P2dUA9+2CmiONZBYBhGqzBdZj+lYkxY';

/** TEST ONLY: a throwaway ECDSA P-256 key encrypted with the passphrase “correct horse”. */
const ECDSA_ENCRYPTED = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGAAAABBlb3HEql
s0U6AmpEhahB1xAAAAGAAAAAEAAABoAAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlz
dHAyNTYAAABBBDJaOp4H+2HQmHvnx+6b783MbrWirwAGYjcjBfpIAenjN1zyzOlHWg85de
FUgWckoDBFJ/zkI3LeGC3Eln6rb30AAACw8oN3fNG/Ca1Q3gteujCJNKc9TxUrHoTvXWzQ
vgn1DGVjuxf/NhCszjE8siCjAf5upErklZX1gBoqxZwNhRCeKekoJBGGcG/k9hPPxybtD5
cykx1EsSox7TFpCfX2mfdaAg1V7aTWOIvKiBVPvy+lFFHxFjq/IizgxZw3ALeBJvWF3uxM
4K+AnCuzONJoBJ+EkAFXO1deg4RdienR0sLyQJgRjpVchXQ1pkCXs/UeLZo=
-----END OPENSSH PRIVATE KEY-----`;
const ECDSA_PUBLIC =
  'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBDJaOp4H+2HQmHvnx+6b783MbrWirwAGYjcjBfpIAenjN1zyzOlHWg85deFUgWckoDBFJ/zkI3LeGC3Eln6rb30=';
const ECDSA_FINGERPRINT = 'SHA256:U3j2RVZhnFgJSwRtHaWDKTLTbMZTip8F6E6OQv9P3Js';

const HOST_KEY = {
  algorithm: 'ssh-ed25519',
  fingerprint: 'SHA256:lA0GcvPK3fxFYd43pMMqq275b2pIPqT3oQfQlcC3wnU',
};
const T = '2026-10-01T09:00:00.000Z';

/** An `openssh-key-v1` container holding public keys of the given algorithms (no real key material). */
function opensshWith(algorithms: string[], cipher = 'none'): string {
  const enc = { encode: (t: string) => Uint8Array.from(t, (c) => c.charCodeAt(0)) };
  const str = (b: Uint8Array) => {
    const out = new Uint8Array(4 + b.length);
    new DataView(out.buffer).setUint32(0, b.length);
    out.set(b, 4);
    return out;
  };
  const u32 = (n: number) => {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, n);
    return out;
  };
  const parts = [
    enc.encode('openssh-key-v1\0'),
    str(enc.encode(cipher)),
    str(enc.encode('none')),
    str(new Uint8Array()),
    u32(algorithms.length),
    ...algorithms.map((a) => str(new Uint8Array([...str(enc.encode(a)), ...new Uint8Array(32)]))),
    str(new Uint8Array(64)),
  ];
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    bytes.set(p, o);
    o += p.length;
  }
  const b64 = bytesToBase64(bytes).replace(/(.{70})/g, '$1\n');
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

const server = (over: Partial<VaultSshServer> = {}): VaultSshServer => ({
  id: 'vss_web1',
  name: 'web-1',
  host: 'web1.example.com',
  port: 22,
  username: 'deploy',
  password: { set: false, setAt: null },
  production: false,
  hostKey: { ...HOST_KEY, trustedAt: T },
  seenHostKey: null,
  check: { status: 'reached', outcome: 'reached', summary: 'Signed in as deploy', checkedAt: T },
  createdAt: T,
  updatedAt: T,
  ...over,
});

describe('the ssh kind and template (VT-S02)', () => {
  it('is the template “Server key”, signing in with ssh_key', () => {
    expect(VAULT_TEMPLATE_DEFS.ssh).toMatchObject({ kind: 'ssh', label: 'Server key', auth: 'ssh_key' });
    expect(VAULT_TEMPLATE_DEFS.ssh.description).toContain('sign in to your servers');
    expect(vaultTemplateOf('ssh', null)).toBe('ssh');
    expect(vaultEntryLabel({ kind: 'ssh', auth: null })).toBe('Server key');
  });

  it('keeps the public half, its fingerprint and origin in auth', () => {
    const auth = {
      type: 'ssh_key',
      keyType: 'ed25519',
      publicKey: ED25519_PUBLIC,
      fingerprint: ED25519_FINGERPRINT,
      origin: 'generated',
    };
    expect(VaultAuth.parse(auth)).toEqual(auth);
    expect(VaultAuth.safeParse({ ...auth, publicKey: `${ED25519_PUBLIC} mara@laptop` }).success).toBe(false);
    expect(VaultAuth.safeParse({ ...auth, fingerprint: 'MD5:aa:bb' }).success).toBe(false);
    expect(VaultAuth.safeParse({ ...auth, keyType: 'dsa' }).success).toBe(false);
  });

  it('checks an ssh entry’s shape: a key source, no URL, auth or secret', () => {
    expect(vaultEntryShapeProblems({ kind: 'ssh', sshKey: { mode: 'generate' } })).toEqual([]);
    expect(
      vaultEntryShapeProblems({ kind: 'ssh', sshKey: { mode: 'import', privateKey: ED25519_PRIVATE } }),
    ).toEqual([]);
    expect(vaultEntryShapeProblems({ kind: 'ssh' }).map((p) => p.field)).toEqual(['sshKey']);
    expect(
      vaultEntryShapeProblems({
        kind: 'ssh',
        url: 'https://x.example.com',
        auth: { type: 'bearer' },
        secret: 'x',
        sshKey: { mode: 'generate' },
      }).map((p) => p.field),
    ).toEqual(['url', 'auth', 'secret']);
    // An update checks the merged entry, which holds the server-written ssh_key.
    const auth = VaultAuth.parse({
      type: 'ssh_key',
      keyType: 'ed25519',
      publicKey: ED25519_PUBLIC,
      fingerprint: ED25519_FINGERPRINT,
      origin: 'imported',
    });
    expect(vaultEntryShapeProblems({ kind: 'ssh', auth }, 'update')).toEqual([]);
    expect(
      vaultEntryShapeProblems({ kind: 'http', url: 'https://a.example.com', auth, secret: 'x' }),
    ).toEqual([{ field: 'auth', message: 'Only an SSH key entry signs in with a key.' }]);
    expect(
      vaultEntryShapeProblems({ kind: 'secret', secret: 'x', sshKey: { mode: 'generate' } }).map(
        (p) => p.field,
      ),
    ).toEqual(['sshKey', 'kind']);
  });

  it('parses a view without servers: servers and serverCount are defaulted', () => {
    const detail = {
      id: 'vlt_old',
      name: 'Grafana',
      description: '',
      kind: 'http',
      url: 'https://grafana.example.com',
      auth: { type: 'bearer' },
      secret: { set: true, setAt: T },
      check: { status: 'unchecked', summary: '', checkedAt: null },
      agentOn: true,
      lastUsedAt: null,
      createdAt: T,
      updatedAt: T,
      tools: [],
      key: { givenAt: T, servers: null, envName: 'GRAFANA' },
      recentUses: [
        {
          id: 'vlu_1',
          entryId: 'vlt_old',
          agentId: 'prn_neo',
          requesterId: 'prn_mara',
          dispatchId: null,
          what: 'in Neo’s commands for this turn',
          outcome: 'done',
          at: T,
          eventId: null,
        },
      ],
    };
    const parsed = VaultEntryDetail.parse(detail);
    expect(parsed.servers).toEqual([]);
    expect(parsed.serverCount).toBe(0);
    expect(parsed.key?.servers).toBeNull();
    expect(parsed.recentUses[0]).not.toHaveProperty('exitCode');
  });

  it('round-trips a server and a key that covers some servers', () => {
    expect(VaultSshServer.parse(server())).toEqual(server());
    const waiting = server({
      hostKey: null,
      seenHostKey: { ...HOST_KEY, seenAt: T },
      check: {
        status: 'unchecked',
        outcome: 'host_key_unconfirmed',
        summary: 'Host key not confirmed yet',
        checkedAt: T,
      },
    });
    expect(VaultSshServer.parse(waiting)).toEqual(waiting);
    expect(VaultSshServer.safeParse({ ...server(), id: 'vlt_x' }).success).toBe(false);
    const key = { givenAt: T, servers: ['vss_web1'], envName: null };
    expect(VaultKeyView.parse(key)).toEqual(key);
    expect(VaultKeyView.parse({ ...key, servers: [] }).servers).toEqual([]);
    expect(VaultKeyView.safeParse({ ...key, servers: ['vss_a', 'vss_a'] }).success).toBe(false);
  });
});

describe('servers: names, users, hosts (VT-S04)', () => {
  it('takes handles agents use, capitals too (CT-319)', () => {
    for (const name of ['web-1', 'nas', 'db.prod', 'a', '0_x', 'x'.repeat(40), 'PVE-01', 'Web-1', 'NAS'])
      expect(VaultSshServerName.safeParse(name).success, name).toBe(true);
    for (const name of ['', '-web', '.x', '_X', 'web 1', 'PVE 01', 'web/1', 'x'.repeat(41), 'wéb'])
      expect(VaultSshServerName.safeParse(name).success, name).toBe(false);
  });

  it('takes POSIX-ish usernames up to 32', () => {
    for (const u of ['deploy', 'backup', '_svc', 'git-user', 'a.b', 'machine$', 'x'.repeat(32)])
      expect(VaultSshUsername.safeParse(u).success, u).toBe(true);
    for (const u of ['', '1deploy', '-x', 'de ploy', 'a$b', 'root@host', 'x'.repeat(33), 'a:b'])
      expect(VaultSshUsername.safeParse(u).success, u).toBe(false);
  });

  it('reads host names and IP literals canonically', () => {
    expect(parseVaultSshHost('Web1.Example.COM.')).toEqual({ host: 'web1.example.com', hostKind: 'name' });
    expect(parseVaultSshHost('192.168.1.30')).toEqual({ host: '192.168.1.30', hostKind: 'ipv4' });
    expect(parseVaultSshHost('[2001:DB8:0:0::7]')).toEqual({ host: '2001:db8::7', hostKind: 'ipv6' });
    expect(parseVaultSshHost('2001:db8::7')).toEqual({ host: '2001:db8::7', hostKind: 'ipv6' });
    expect(parseVaultSshHost('nas.local')).toEqual({ host: 'nas.local', hostKind: 'name' });
    for (const bad of [
      '',
      '127.1',
      '0x7f.1',
      'a..b',
      'web_1 .x',
      'user@host',
      'host:22',
      '[web1]',
      'x'.repeat(254),
    ])
      expect(parseVaultSshHost(bad), bad).toBeNull();
    expect(VaultSshHost.safeParse(' web1.example.com ').success).toBe(true);
    expect(VaultSshHost.safeParse('ssh://web1').success).toBe(false);
  });

  it('writes a server as user@host:port', () => {
    expect(vaultSshServerTarget(server())).toBe('deploy@web1.example.com:22');
    expect(vaultSshServerTarget(server({ host: '2001:db8::7', port: 2222, username: 'backup' }))).toBe(
      'backup@[2001:db8::7]:2222',
    );
  });
});

describe('vaultSshDestinationProblem (VT-S06)', () => {
  const networks = [{ cidr: '192.168.1.0/24', ports: [22, 8123] }];
  const at = (host: string, port: number, resolved: string[], extra: object = {}) =>
    vaultSshDestinationProblem({ host, port, resolved, networks, ...extra });

  it('allows public servers on the SSH ports only (default [22])', () => {
    expect(at('web1.example.com', 22, ['93.184.215.14'])).toBeNull();
    expect(at('93.184.215.14', 22, [])).toBeNull();
    expect(at('web1.example.com', 2222, ['93.184.215.14'])).toEqual({
      code: 'port_not_allowed',
      message: 'Whombat reaches servers on the internet on port 22 only.',
    });
    expect(at('web1.example.com', 2222, ['93.184.215.14'], { sshPorts: [22, 2222] })).toBeNull();
    expect(at('web1.example.com', 443, ['93.184.215.14'], { sshPorts: [22, 2222, 8022] })?.message).toBe(
      'Whombat reaches servers on the internet on ports 22, 2222 and 8022 only.',
    );
    expect(at('web1.example.com', 2222, ['93.184.215.14'], { sshPorts: [2222, 22] })).toBeNull();
    expect(at('web1.example.com', 22, ['2606:2800:220:1:248:1893:25c8:1946'])).toBeNull();
  });

  it('allows home-network servers on a listed network and port only', () => {
    expect(at('nas.local', 22, ['192.168.1.30'])).toBeNull();
    expect(at('192.168.1.30', 22, [])).toBeNull();
    const refused = at('192.168.1.30', 2222, []);
    expect(refused).toMatchObject({ code: 'not_listed', suggestion: { cidr: '192.168.1.0/24', port: 2222 } });
    expect(refused?.message).toContain('192.168.1.0/24 port 2222');
    expect(refused?.message).not.toMatch(/admin/i);
    expect(at('10.0.0.5', 22, [])).toMatchObject({
      code: 'not_listed',
      suggestion: { cidr: '10.0.0.0/24', port: 22 },
    });
    // The public SSH ports don't open private addresses.
    expect(at('10.0.0.5', 22, [], { sshPorts: [22] })?.code).toBe('not_listed');
  });

  it('reaches any private server on any port with the local network open (LN-01)', () => {
    expect(at('10.100.0.5', 2222, [], { lan: true })).toBeNull();
    expect(at('nas.local', 22, ['192.168.7.30'], { lan: true })).toBeNull();
    expect(at('127.0.0.1', 22, [], { lan: true })?.code).toBe('never');
    expect(at('mixed.example.com', 22, ['93.184.215.14', '10.0.0.5'], { lan: true })?.code).toBe('mixed');
  });

  it('never reaches loopback, link-local, metadata and the other never-listable ranges', () => {
    const wide = [{ cidr: '0.0.0.0/0', ports: [22] }];
    for (const ip of [
      '127.0.0.1',
      '169.254.169.254',
      '169.254.1.1',
      '0.0.0.0',
      '224.0.0.1',
      '192.0.2.4',
      '::1',
      'fe80::1',
    ])
      expect(vaultSshDestinationProblem({ host: ip, port: 22, resolved: [], networks: wide })?.code, ip).toBe(
        'never',
      );
    expect(at('evil.example.com', 22, ['127.0.0.1'])?.code).toBe('never');
    expect(at('evil.example.com', 22, ['::ffff:127.0.0.1'])?.code).toBe('never');
  });

  it('needs every resolved address to pass (DNS rebinding, mixed answers)', () => {
    expect(at('mixed.example.com', 22, ['93.184.215.14', '192.168.1.30'])?.code).toBe('mixed');
    expect(at('rebind.example.com', 22, ['192.168.1.30', '192.168.2.30'])?.code).toBe('not_listed');
    expect(at('gone.example.com', 22, [])?.code).toBe('unresolved');
    expect(at('gone.example.com', 22, ['not-an-ip'])?.code).toBe('unresolved');
    expect(at('bad host', 22, [])?.code).toBe('bad_host');
  });

  it('says “isn’t allowed any more” at call time', () => {
    expect(at('192.168.1.30', 2222, [], { at: 'call' })).toEqual({
      code: 'not_listed',
      message: VAULT_SSH_ADDRESS_NOT_ALLOWED_ANY_MORE,
    });
    expect(VAULT_SSH_ADDRESS_NOT_ALLOWED_ANY_MORE).toBe('This server’s address isn’t allowed any more.');
    expect(at('192.168.1.30', 22, [], { at: 'call' })).toBeNull();
  });

  it('reads WHOMBAT_VAULT_SSH_PORTS', () => {
    expect(parseVaultSshPorts(undefined)).toEqual([22]);
    expect(parseVaultSshPorts('')).toEqual([22]);
    expect(parseVaultSshPorts('22')).toEqual([22]);
    expect(parseVaultSshPorts(' 2222, 22 ')).toEqual([22, 2222]);
    for (const bad of [
      '0',
      '65536',
      '22,22',
      'ssh',
      '22;2222',
      '-1',
      '022',
      Array(17)
        .fill(0)
        .map((_, i) => i + 1)
        .join(','),
    ])
      expect(parseVaultSshPorts(bad), bad).toBeNull();
  });
});

describe('keys cover servers (VT-S07)', () => {
  it('covers every server with null (later ones too), else the listed ones', () => {
    expect(vaultKeyCoversServer({ servers: null }, 'vss_any')).toBe(true);
    expect(vaultKeyCoversServer({}, 'vss_any')).toBe(true);
    expect(vaultKeyCoversServer({ servers: ['vss_a'] }, 'vss_a')).toBe(true);
    expect(vaultKeyCoversServer({ servers: ['vss_a'] }, 'vss_b')).toBe(false);
    expect(vaultKeyCoversServer({ servers: [] }, 'vss_a')).toBe(false);
    const servers = [server({ id: 'vss_a', name: 'a' }), server({ id: 'vss_b', name: 'b' })];
    expect(vaultKeyCoveredServers({ servers: ['vss_b', 'vss_gone'] }, servers).map((s) => s.name)).toEqual([
      'b',
    ]);
    expect(vaultKeyCoveredServers({ servers: null }, servers)).toHaveLength(2);
    expect(vaultKeyServersText(null, servers)).toBe('All servers');
    expect(vaultKeyServersText(['vss_b', 'vss_a'], servers)).toBe('a, b');
    expect(vaultKeyServersText([], servers)).toBe('No servers');
  });
});

describe('public keys, fingerprints and the authorized_keys line (VT-S02, VT-S13)', () => {
  it('fingerprints as ssh-keygen -l does', () => {
    expect(vaultSshFingerprint(ED25519_PUBLIC)).toBe(ED25519_FINGERPRINT);
    expect(vaultSshFingerprint(`${ED25519_PUBLIC} mara@laptop`)).toBe(ED25519_FINGERPRINT);
    expect(vaultSshFingerprint(ECDSA_PUBLIC)).toBe(ECDSA_FINGERPRINT);
    expect(vaultSshFingerprint('ssh-dss AAAAB3NzaC1kc3M=')).toBeNull();
    expect(
      vaultSshFingerprint('ssh-rsa AAAAC3NzaC1lZDI1NTE5AAAAILBmrVrARUqTYfBxNry+DHEJ+VGkRAsfW8i0duG7bwv5'),
    ).toBeNull();
  });

  it('reads a public key line, dropping the comment', () => {
    expect(parseVaultSshPublicKey(`${ED25519_PUBLIC} test`)).toMatchObject({
      algorithm: 'ssh-ed25519',
      keyType: 'ed25519',
      line: ED25519_PUBLIC,
    });
    expect(parseVaultSshPublicKey(ECDSA_PUBLIC)?.keyType).toBe('ecdsa');
    expect(parseVaultSshPublicKey('ssh-ed25519-cert-v01@openssh.com AAAA')).toBeNull();
    expect(parseVaultSshPublicKey('sk-ssh-ed25519@openssh.com AAAA')).toBeNull();
  });

  it('builds `restrict <publicKey> whombat-<entry key>`', () => {
    const key = vaultEntryKey('vlt_deploykey');
    expect(vaultSshAuthorizedKeysLine(ED25519_PUBLIC, 'vlt_deploykey')).toBe(
      `restrict ${ED25519_PUBLIC} whombat-${key}`,
    );
    expect(vaultSshAuthorizedKeysLine(`${ED25519_PUBLIC} old comment`, 'vlt_deploykey')).toBe(
      `restrict ${ED25519_PUBLIC} whombat-${key}`,
    );
    expect(key).toMatch(/^[a-z]{8}$/);
  });

  it('names host key types and the file to compare with', () => {
    expect(vaultSshHostKeyLabel('ssh-ed25519')).toBe('ED25519');
    expect(vaultSshHostKeyLabel('ecdsa-sha2-nistp384')).toBe('ECDSA');
    expect(vaultSshHostKeyLabel('rsa-sha2-512')).toBe('RSA');
    expect(vaultSshHostKeyLabel('ssh-rsa')).toBe('RSA');
    expect(vaultSshHostKeyFile('ssh-ed25519')).toBe('/etc/ssh/ssh_host_ed25519_key.pub');
    expect(vaultSshHostKeyFile('ecdsa-sha2-nistp256')).toBe('/etc/ssh/ssh_host_ecdsa_key.pub');
    expect(vaultSshHostKeyFile('rsa-sha2-256')).toBe('/etc/ssh/ssh_host_rsa_key.pub');
  });

  it('encodes and decodes base64 without Buffer', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253]);
    expect(bytesToBase64(bytes)).toBe('AAEC+vv8/Q==');
    expect(bytesToBase64(bytes, false)).toBe('AAEC+vv8/Q');
    expect([...(base64ToBytes('AAEC+vv8/Q==') ?? [])]).toEqual([...bytes]);
    expect([...(base64ToBytes('AAEC\n+vv8/Q') ?? [])]).toEqual([...bytes]);
    expect(base64ToBytes('A')).toBeNull();
    expect(base64ToBytes('!!!!')).toBeNull();
  });
});

describe('private keys as pasted (VT-S03)', () => {
  it('reads an OpenSSH key: format, encryption, algorithm and public half', () => {
    expect(inspectVaultSshPrivateKey(ED25519_PRIVATE)).toEqual({
      ok: true,
      key: { format: 'openssh', encrypted: false, algorithm: 'ssh-ed25519', publicKey: ED25519_PUBLIC },
    });
    expect(inspectVaultSshPrivateKey(ECDSA_ENCRYPTED)).toEqual({
      ok: true,
      key: { format: 'openssh', encrypted: true, algorithm: 'ecdsa-sha2-nistp256', publicKey: ECDSA_PUBLIC },
    });
    expect(inspectVaultSshPrivateKey(`Some text\n${ED25519_PRIVATE.replace(/\n/g, '\r\n')}`).ok).toBe(true);
  });

  it('reads PEM keys, encrypted ones by their headers', () => {
    const pem = (label: string, headers = '') =>
      `-----BEGIN ${label}-----\n${headers}MIIEowIBAAKCAQEA0trHO7NYL8FHZw7q6U8Fapm9apRLpD/EdrrWlc0+DOjG/QZP\n-----END ${label}-----`;
    expect(inspectVaultSshPrivateKey(pem('RSA PRIVATE KEY'))).toMatchObject({
      ok: true,
      key: { format: 'rsa', encrypted: false, publicKey: null },
    });
    expect(
      inspectVaultSshPrivateKey(
        pem('RSA PRIVATE KEY', 'Proc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,00FF\n\n'),
      ),
    ).toMatchObject({ ok: true, key: { format: 'rsa', encrypted: true } });
    expect(inspectVaultSshPrivateKey(pem('EC PRIVATE KEY'))).toMatchObject({
      ok: true,
      key: { format: 'ec' },
    });
    expect(inspectVaultSshPrivateKey(pem('PRIVATE KEY'))).toMatchObject({
      ok: true,
      key: { format: 'pkcs8' },
    });
    expect(inspectVaultSshPrivateKey(pem('ENCRYPTED PRIVATE KEY'))).toMatchObject({
      ok: true,
      key: { format: 'pkcs8_encrypted', encrypted: true },
    });
  });

  it('refuses what it can tell isn’t an importable private key, in a sentence', () => {
    const code = (text: string) => {
      const r = inspectVaultSshPrivateKey(text);
      return r.ok ? null : r.code;
    };
    expect(code('')).toBe('empty');
    expect(code('x'.repeat(16_001))).toBe('too_long');
    expect(code('hello')).toBe('not_a_key');
    expect(code(ED25519_PUBLIC)).toBe('public_key');
    expect(code(`${ED25519_PUBLIC} test`)).toBe('public_key');
    expect(code('-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----')).toBe('public_key');
    expect(code('PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none')).toBe('putty');
    expect(code('ssh-ed25519-cert-v01@openssh.com AAAAIHNzaC1lZDI1NTE5LWNlcnQtdjAxQG9wZW5zc2guY29t')).toBe(
      'certificate',
    );
    expect(code(`${ED25519_PRIVATE}\n${ED25519_PRIVATE}`)).toBe('several_keys');
    expect(code(opensshWith(['ssh-ed25519', 'ssh-ed25519']))).toBe('several_keys');
    expect(code(opensshWith(['sk-ssh-ed25519@openssh.com']))).toBe('fido');
    expect(code(opensshWith(['sk-ecdsa-sha2-nistp256@openssh.com'], 'aes256-ctr'))).toBe('fido');
    expect(code(opensshWith(['ssh-dss']))).toBe('unsupported_type');
    expect(code(opensshWith(['ssh-ed25519']))).toBeNull();
    expect(code('-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----')).toBe(
      'not_a_key',
    );
    expect(code('-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEA')).toBe('not_a_key');
    expect(code('-----BEGIN DSA PRIVATE KEY-----\nAAAA\n-----END DSA PRIVATE KEY-----')).toBe('not_a_key');
    for (const message of Object.values(VAULT_SSH_KEY_PROBLEM_TEXT)) expect(message).not.toMatch(/'/);
  });
});

describe('the forms a private key never reaches an agent in (VT-S10)', () => {
  it('takes the lines that carry private bytes, not the shared header or public key', () => {
    const lines = vaultSshPrivateKeyLines(ED25519_PRIVATE);
    // Line 1 is the same in every unencrypted ed25519 key; lines 2–4 carry the check integers and the key.
    expect(lines).not.toContain('b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW');
    expect(lines).toContain('QyNTUxOQAAACCwZq1awEVKk2HwcTa8vgxxCflRpEQLH1vItHbhu28L+QAAAIibQrhum0K4');
    expect(lines).toContain('AAAECq5lZhxOthCAsMc3+7yD+sGL5dQ6MnR2zxpf5kgTmIdrBmrVrARUqTYfBxNry+DHEJ');
    expect(lines).toContain('+VGkRAsfW8i0duG7bwv5AAAABHRlc3QB');
    expect(
      vaultSshPrivateKeyLines(ED25519_PRIVATE.replace('+VGkRAsfW8i0duG7bwv5AAAABHRlc3QB', 'AAAB')),
    ).toHaveLength(3);
    expect(vaultSshPrivateKeyLines('no key here')).toEqual([]);
  });

  it('lists the whole text, its lines, raw bytes and the passphrase, longest first', () => {
    const forms = vaultSshKeyForms({
      privateKeys: [ED25519_PRIVATE],
      raw: ['quZWYcTrYQgLDHN/u8g/rBi+XUOjJ0ds8aX+ZIE5iHY='],
      passphrase: 'correct horse',
    });
    expect(forms[0]).toBe(ED25519_PRIVATE.trim().replace(/\n/g, '\r\n'));
    expect(forms).toContain(ED25519_PRIVATE.trim());
    expect(forms).toContain(JSON.stringify(ED25519_PRIVATE.trim()).slice(1, -1));
    expect(forms).toContain('quZWYcTrYQgLDHN/u8g/rBi+XUOjJ0ds8aX+ZIE5iHY');
    expect(forms).toContain('correct horse');
    for (let i = 1; i < forms.length; i++)
      expect((forms[i - 1] as string).length).toBeGreaterThanOrEqual((forms[i] as string).length);
    expect(vaultSshKeyForms({ privateKeys: [], passphrase: 'short' })).toEqual([]);
  });

  it('finds an echo of the key file, even with another comment, but not the public key or another key', () => {
    const forms = vaultSshKeyForms({ privateKeys: [ED25519_PRIVATE] });
    expect(holdsVaultSshKey(`$ cat ~/.ssh/id_ed25519\n${ED25519_PRIVATE}`, forms)).toBe(true);
    const otherComment = ED25519_PRIVATE.replace(
      '+VGkRAsfW8i0duG7bwv5AAAABHRlc3QB',
      '+VGkRAsfW8i0duG7bwv5AAAADW1hcmFAbGFwdG9wAQIDBAU=',
    );
    expect(holdsVaultSshKey(otherComment, forms)).toBe(true);
    expect(holdsVaultSshKey(`${ED25519_PUBLIC} test`, forms)).toBe(false);
    expect(holdsVaultSshKey(vaultSshAuthorizedKeysLine(ED25519_PUBLIC, 'vlt_x'), forms)).toBe(false);
    expect(holdsVaultSshKey(opensshWith(['ssh-ed25519']), forms)).toBe(false);
    expect(holdsVaultSshKey(JSON.stringify({ out: ED25519_PRIVATE }), forms)).toBe(true);
  });
});

describe('uses, checks and copy (VT-S05, VT-S11…VT-S13)', () => {
  it('shows RECENT USE as one row per turn of the person (CT-1244)', () => {
    const use = VaultUse.parse({
      id: 'vlu_s',
      entryId: 'vlt_deploykey',
      agentId: 'prn_neo',
      requesterId: 'prn_mara',
      dispatchId: null,
      what: 'in Neo’s commands for this turn',
      outcome: 'done',
      at: T,
      eventId: null,
    });
    const row = vaultUseRow(use, {
      names: (id) => ({ prn_neo: { shortName: 'Neo' } })[id],
      now: T,
      timeZone: 'UTC',
    });
    expect(row.what).toBe(use.what);
    expect(row).not.toHaveProperty('forWhom');
    expect(row.outcome).toBe('done');
    expect(
      vaultUseRow({ ...use, outcome: 'refused' }, { names: () => undefined, now: T, timeZone: 'UTC' })
        .outcome,
    ).toBe('refused');
    expect(VaultUse.parse({ ...use, exitCode: 0, server: 'web-1' })).not.toHaveProperty('exitCode');
  });

  it('summarises a server’s check and gives its dot', () => {
    expect(vaultSshCheckSummary('reached', { username: 'deploy' })).toBe('Signed in as deploy');
    expect(vaultSshCheckSummary('host_key_unconfirmed')).toBe('Not trusted yet');
    expect(vaultSshCheckSummary('host_key_changed')).toMatch(
      /^It doesn’t look like the same server any more\./,
    );
    expect(vaultSshCheckSummary('rejected')).toBe('The server refused the key.');
    expect(vaultSshCheckSummary('unreachable')).toBe('Couldn’t reach it.');
    expect(vaultSshCheckSummary('timeout')).toBe('It didn’t answer within 30 seconds.');
    expect(vaultSshCheckSummary('not_allowed', { reason: 'nope.' })).toBe('Not allowed: nope.');
    expect(vaultCheckSummary('reached', { kind: 'ssh', username: 'backup' })).toBe('Signed in as backup');
    expect(vaultCheckSummary('host_key_changed', { kind: 'mcp' })).toBe(VAULT_SSH_COPY.hostKeyChanged);
    expect(vaultSshCheckStatus('reached')).toBe('reached');
    expect(vaultSshCheckStatus('host_key_unconfirmed')).toBe('unchecked');
    expect(vaultSshCheckStatus('host_key_changed')).toBe('failing');
    expect(vaultSshCheckStatus('rejected')).toBe('failing');
  });

  it('is ready only with a trusted host key and nothing else seen', () => {
    expect(vaultSshServerReady(server())).toBe(true);
    expect(vaultSshServerReady(server({ hostKey: null, seenHostKey: { ...HOST_KEY, seenAt: T } }))).toBe(
      false,
    );
    expect(vaultSshServerReady(server({ seenHostKey: { ...HOST_KEY, seenAt: T } }))).toBe(false);
  });

  it('takes an entry’s check from its servers', () => {
    expect(vaultSshEntryCheck([])).toEqual({
      status: 'unchecked',
      summary: 'No servers yet',
      checkedAt: null,
      toolCount: null,
    });
    expect(vaultSshEntryCheck([server()])).toEqual({
      status: 'reached',
      summary: 'Signed in as deploy',
      checkedAt: T,
      toolCount: null,
    });
    const waiting = server({
      id: 'vss_b',
      check: {
        status: 'unchecked',
        outcome: 'host_key_unconfirmed',
        summary: 'Host key not confirmed yet',
        checkedAt: '2026-10-01T10:00:00.000Z',
      },
    });
    const failing = server({
      id: 'vss_c',
      check: { status: 'failing', outcome: 'rejected', summary: 'x', checkedAt: T },
    });
    expect(vaultSshEntryCheck([server(), waiting])).toMatchObject({
      status: 'reached',
      summary: 'Signed in to 1 of 2 servers',
      checkedAt: '2026-10-01T10:00:00.000Z',
    });
    expect(vaultSshEntryCheck([server(), server({ id: 'vss_x' })]).summary).toBe(
      'Signed in to all 2 servers',
    );
    expect(vaultSshEntryCheck([server(), waiting, failing])).toMatchObject({
      status: 'failing',
      summary: '1 of 3 servers failing',
    });
    expect(vaultSshEntryCheck([waiting, waiting]).status).toBe('unchecked');
  });

  it('writes the card meta line', () => {
    const auth = VaultAuth.parse({
      type: 'ssh_key',
      keyType: 'ed25519',
      publicKey: ED25519_PUBLIC,
      fingerprint: ED25519_FINGERPRINT,
      origin: 'generated',
    });
    expect(vaultEntryMeta({ kind: 'ssh', auth, url: null, agentOn: true, serverCount: 3 }, 'Dusty')).toBe(
      'Server key · 3 servers · on for Dusty',
    );
    expect(vaultEntryMeta({ kind: 'ssh', auth, url: null, agentOn: false, serverCount: 1 }, 'Dusty')).toBe(
      'Server key · 1 server · off for Dusty',
    );
    expect(vaultEntryMeta({ kind: 'ssh', auth, url: null, agentOn: true }, 'Dusty')).toBe(
      'Server key · no servers · on for Dusty',
    );
    // The quieter line: how many servers; the algorithm is the entry's technical detail.
    expect(vaultEntryWhere({ kind: 'ssh', url: null, serverCount: 2 })).toBe('2 servers');
  });

  it('asks one question in words before trusting a server, and reads old host-key lines plainly', () => {
    const staging = { name: 'staging', host: 'staging.example.com', port: 22 };
    expect(vaultSshTrustQuestion(staging, false)).toBe('Is staging the server at staging.example.com?');
    expect(vaultSshTrustQuestion({ ...staging, host: '2001:db8::7', port: 2222 }, false)).toContain(
      '[2001:db8::7]:2222',
    );
    expect(vaultSshTrustQuestion(staging, true)).toMatch(
      /^staging at staging\.example\.com doesn’t look like/,
    );
    expect(vaultSshTrustQuestion(staging, true)).not.toMatch(/host key|SHA256/);
    // A check stored with the words of before reads in today's.
    const line = vaultSshServerCheckLine(
      {
        check: {
          status: 'unchecked',
          outcome: 'host_key_unconfirmed',
          summary: 'Host key not confirmed yet',
          checkedAt: T,
        },
      },
      T,
      'UTC',
    );
    expect(line).toMatch(/· Not trusted yet$/);
  });

  it('writes the trust card verbatim', () => {
    const card = vaultSshTrustCopy(HOST_KEY);
    expect(card.text).toBe(
      'Is this your server? SHA256:lA0GcvPK3fxFYd43pMMqq275b2pIPqT3oQfQlcC3wnU (ED25519). Compare it with ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub on the server.',
    );
    expect(card.command).toBe('ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub');
    expect(card.action).toBe('Yes, trust it');
    expect(
      vaultSshTrustCopy({ algorithm: 'ecdsa-sha2-nistp256', fingerprint: HOST_KEY.fingerprint }).fingerprint,
    ).toBe(`${HOST_KEY.fingerprint} (ECDSA).`);
  });

  it('keeps the spec’s copy verbatim', () => {
    expect(VAULT_SSH_COPY.authorizedKeysHint).toContain('~/.ssh/authorized_keys');
    expect(VAULT_SSH_COPY.authorizedKeysHint).toContain('the user the agent signs in as');
    expect(VAULT_SSH_COPY.generate).toBe('Generate a new key');
    expect(VAULT_SSH_COPY.useOwn).toBe('Use my own key');
    expect(VAULT_SSH_COPY.passphrase).toBe('Passphrase (if it has one)');
    expect(VAULT_SSH_COPY.replaceOwn).toBe('Replace with my own key');
    expect(VAULT_SSH_COPY.trust).toBe('Yes, trust it');
    expect(VAULT_SSH_COPY.allServers).toBe('All servers');
    expect(VAULT_SSH_COPY.sshOnWeb).toBe('SSH keys and servers are set up on the web, in the Vault.');
    expect(VAULT_SSH_COPY.publicKey).toBe('PUBLIC KEY');
    expect(VAULT_SSH_COPY.servers).toBe('SERVERS');
    expect(VAULT_FAILURE_TEXT.rejected).toBe('The server refused the key.');
  });

  it('lists a covered server for the turn by its name, target and readiness (VT-S12, CT-1243)', () => {
    const listed = VaultContextSshServer.parse({
      name: 'web-1',
      target: vaultSshServerTarget(server()),
      ready: vaultSshServerReady(server()),
    });
    expect(listed).toEqual({ name: 'web-1', target: 'deploy@web1.example.com:22', ready: true });
    expect(VaultContextSshServer.safeParse({ name: 'web-1', target: null, ready: true }).success).toBe(false);
  });

  it('has no relayed SSH tools (CT-1242)', () => {
    for (const name of ['ssh_exec', 'ssh_read_file', 'ssh_write_file', 'ssh_upload'])
      expect(MCP_TOOLS, name).not.toHaveProperty(name);
  });
});
