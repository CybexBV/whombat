import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BACKUP_CALL_TIMEOUT_MS,
  BACKUP_DOWN_TEXT,
  BackupServiceDown,
  BackupSocketClient,
  destinationHost,
  destinationKind,
  destinationRefusal,
  LIST,
  sessionPort,
  withoutCredentials,
} from './backup';

describe('backup destinations (MD-17)', () => {
  it('names a destination’s kind and host for the audit event, never a path or a user', () => {
    const cases: [string, string, string][] = [
      ['rest:https://backup.example.com/appliance/', 'rest', 'backup.example.com'],
      ['rest:https://backup.example.com:8000/x/', 'rest', 'backup.example.com:8000'],
      ['s3:https://s3.eu-central-1.amazonaws.com/bucket/whombat', 's3', 's3.eu-central-1.amazonaws.com'],
      ['s3:minio.example.net:9000/bucket', 's3', 'minio.example.net:9000'],
      ['sftp:nas.local:/volume1/whombat', 'sftp', 'nas.local'],
      ['sftp://nas.local:2222//volume1/whombat', 'sftp', 'nas.local:2222'],
      ['sftp:[fd00::5]:/srv/backup', 'sftp', '[fd00::5]'],
      ['disk:', 'disk', 'disk'],
      ['/var/lib/whombat-backup/repo', 'local', 'local'],
      ['rest:not a url', 'rest', 'unknown'],
    ];
    for (const [repository, kind, host] of cases) {
      expect(destinationKind(repository), repository).toBe(kind);
      expect(destinationHost(repository), repository).toBe(host);
    }
  });

  it('takes every credential the person sent out of a refusal’s text', () => {
    const input = {
      repository: 's3:https://s3.example.com/b',
      s3AccessKeyId: 'AKIAEXAMPLEKEY',
      s3SecretAccessKey: 'wJalrXUtnFEMI/K7MDENG',
      restPassword: 'rest-pass',
      adoptPassword: 'kit-password',
      restUser: 'backup-operator',
    };
    expect(
      withoutCredentials(
        'bucket refused AKIAEXAMPLEKEY / wJalrXUtnFEMI/K7MDENG (rest-pass, kit-password) as backup-operator for s3.example.com',
        input,
      ),
    ).toBe(
      'bucket refused [redacted] / [redacted] ([redacted], [redacted]) as [redacted] for s3.example.com',
    );
    expect(withoutCredentials('no such bucket', { repository: 'disk:' })).toBe('no such bucket');
    // SFTP's user too.
    expect(
      withoutCredentials('permission denied for whombat-nas', {
        repository: 'sftp:nas.local:/b',
        sftpUser: 'whombat-nas',
      }),
    ).toBe('permission denied for [redacted]');
  });

  it('removes a credential cut short at the end, by the service or at our own cut', () => {
    const secret = 'wJalrXUtnFEMI/K7MDENGbPxRfiCYEXAMPLEKEY';
    const input = { repository: 's3:https://s3.example.com/b', s3SecretAccessKey: secret };
    // The service cut its own message inside the secret.
    expect(withoutCredentials(`signature mismatch for ${secret.slice(0, 12)}`, input)).toBe(
      'signature mismatch for [redacted]',
    );
    // Fewer than 8 characters is too little to be the secret.
    expect(withoutCredentials('ends with wJalrXU', input)).toBe('ends with wJalrXU');
    // A secret straddling our 300-character cut leaves nothing of itself.
    const padding = 'x'.repeat(290);
    const refusal = destinationRefusal({ error: `${padding}${secret} and more text` }, input);
    expect(refusal).toBe(`${padding}[redacted]`);
    for (let n = 4; n <= secret.length; n++) expect(refusal).not.toContain(secret.slice(0, n));
    // A secret the service itself cut short, lying across our cut.
    const cut = destinationRefusal({ error: `${padding}${secret.slice(0, 20)} (truncated)` }, input);
    expect(cut).not.toContain(secret.slice(0, 8));
    expect(cut.startsWith(padding)).toBe(true);
  });
});

describe('the backup service socket client', () => {
  it('waits long enough for a disk destination to be formatted and mounted (≥ 180 s, BK-20)', () => {
    expect(BACKUP_CALL_TIMEOUT_MS).toBeGreaterThanOrEqual(180_000);
  });

  it('waits out a slow answer within its timeout and gives up after it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-backup-sock-'));
    const socket = join(dir, 'api.sock');
    const server = createServer((req, res) => {
      setTimeout(() => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ method: req.method, path: req.url }));
      }, 300);
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      expect(await new BackupSocketClient(socket, 2_000).call('PUT', '/v1/destination', {})).toEqual({
        status: 200,
        body: { method: 'PUT', path: '/v1/destination' },
      });
      await expect(new BackupSocketClient(socket, 100).call('PUT', '/v1/destination', {})).rejects.toThrow(
        /timed out/,
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the socket client’s limits (backup-options.md)', () => {
  it('takes a list past 256 KiB when asked for one, keeps short reads short, and says when nothing answers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-backup-sock-'));
    const socket = join(dir, 'api.sock');
    // About 730 backups of 360 bytes: what broke the list before.
    const big = JSON.stringify({
      checkpoints: Array.from({ length: 800 }, (_, i) => ({ id: `ck-${i}`, pad: 'x'.repeat(340) })),
    });
    const server = createServer((req, res) => {
      if (req.url === '/slow') return void setTimeout(() => res.end('{}'), 1_000);
      res.setHeader('content-type', 'application/json');
      res.end(big);
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      const client = new BackupSocketClient(socket);
      expect(big.length).toBeGreaterThan(256 * 1024);
      await expect(client.call('GET', '/v1/checkpoints')).rejects.toThrow(/too large/);
      const listed = await client.call('GET', '/v1/checkpoints', undefined, LIST);
      expect((listed.body as { checkpoints: unknown[] }).checkpoints).toHaveLength(800);
      await expect(client.call('GET', '/slow', undefined, { deadlineMs: 50 })).rejects.toBeInstanceOf(
        BackupServiceDown,
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    // The socket is gone: the service is down, which people read in plain words.
    const gone = new BackupSocketClient(socket);
    await expect(gone.call('GET', '/v1/status')).rejects.toBeInstanceOf(BackupServiceDown);
    await expect(sessionPort(gone).call('GET', '/v1/status')).rejects.toMatchObject({
      code: 'unavailable',
      message: BACKUP_DOWN_TEXT,
    });
    rmSync(dir, { recursive: true, force: true });
  });
});
