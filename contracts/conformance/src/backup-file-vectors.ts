/**
 * `vectors/backup-file.json` (CT-335): the backup file's container, byte for byte — the Argon2id key derivation (with
 * small parameters, and once with the defaults a server uses), whole files for bodies of several sizes around the chunk
 * size, their keys, HChaCha20 subkey and header, files altered every way the decoder must refuse, and a ustar body. For a
 * server that seals with native code (Node's `crypto.argon2` and `chacha20-poly1305`) and for the offline CLI. Checked by
 * Vitest; nothing in Go reads it.
 */
import {
  BACKUP_HEADER_BYTES,
  BACKUP_KDF_DEFAULT,
  BACKUP_TAG_BYTES,
  BackupFileEncoder,
  type BackupKdfParams,
  backupChunkSubkey,
  backupPasswordBytes,
  createBackupFileKeys,
  nobleBackupKdf,
  TarWriter,
} from '@whombat/core/backup';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const fill = (n: number, v: number) => new Uint8Array(n).fill(v);
const concat = (parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));

/** Deterministic plaintext: byte i = (i * 31 + 7) mod 256. */
export function backupVectorPlaintext(n: number): Uint8Array {
  return new Uint8Array(n).map((_, i) => (i * 31 + 7) & 0xff);
}

const SMALL: BackupKdfParams = { memoryKiB: 64, passes: 2, parallelism: 1 };
const PASSWORD = 'correct horse battery staple';
const SALT = fill(16, 0x11);
const PREFIX = fill(16, 0x22);
const CHUNK = 1024;

async function file(name: string, size: number) {
  const keys = await createBackupFileKeys(PASSWORD, {
    params: SMALL,
    chunkBytes: CHUNK,
    salt: SALT,
    noncePrefix: PREFIX,
  });
  const enc = new BackupFileEncoder(keys);
  const plain = backupVectorPlaintext(size);
  const bytes = concat([...enc.push(plain), ...enc.finish()]);
  return {
    name,
    plaintextSize: size,
    streamKey: hex(keys.streamKey),
    subkey: hex(backupChunkSubkey(keys.streamKey, keys.header.noncePrefix)),
    header: hex(keys.header.bytes),
    headerHash: hex(keys.header.hash),
    file: hex(bytes),
  };
}

export async function backupFileVectors() {
  const ikm = async (password: string, salt: Uint8Array, params: BackupKdfParams) =>
    hex(await nobleBackupKdf(backupPasswordBytes(password), salt, params));
  const files = [
    await file('empty body: one last chunk of 0 bytes', 0),
    await file('one byte', 1),
    await file('exactly one chunk: the last chunk is full', CHUNK),
    await file('two full chunks and a partial last one', 2 * CHUNK + 452),
  ];
  const base = files[3] as { file: string };
  const bytes = Buffer.from(base.file, 'hex');
  const c = CHUNK + BACKUP_TAG_BYTES;
  const at = (i: number) => BACKUP_HEADER_BYTES + i * c;
  const flip = (offset: number) => {
    const b = Buffer.from(bytes);
    b[offset] = (b[offset] as number) ^ 0x01;
    return b.toString('hex');
  };
  const chunk = (i: number) => bytes.subarray(at(i), Math.min(at(i + 1), bytes.length));
  const head = bytes.subarray(0, BACKUP_HEADER_BYTES);
  const tampered = [
    {
      name: 'wrong password',
      file: base.file,
      password: 'correct horse battery stable',
      expect: 'wrong_password',
    },
    {
      name: 'truncated after a full chunk',
      file: bytes.subarray(0, at(2)).toString('hex'),
      expect: 'damaged',
    },
    {
      name: 'last byte missing',
      file: bytes.subarray(0, bytes.length - 1).toString('hex'),
      expect: 'damaged',
    },
    {
      name: 'chunks swapped',
      file: Buffer.concat([head, chunk(1), chunk(0), chunk(2)]).toString('hex'),
      expect: 'damaged',
    },
    { name: 'a ciphertext byte flipped', file: flip(at(1) + 5), expect: 'damaged' },
    { name: 'a tag byte flipped', file: flip(at(1) - 1), expect: 'damaged' },
    { name: 'header checksum broken (salt changed)', file: flip(30), expect: 'damaged' },
    { name: 'not a backup file (magic)', file: flip(0), expect: 'not_backup_file' },
    {
      name: 'container version 2',
      file: Buffer.concat([head.subarray(0, 8), Buffer.from([0, 2]), bytes.subarray(10)]).toString('hex'),
      expect: 'newer_format',
    },
    { name: 'bytes after the last chunk', file: `${base.file}00`, expect: 'damaged' },
  ].map((t) => ({ password: PASSWORD, ...t }));

  const tar = new TarWriter();
  const archive = concat([
    tar.file(
      'manifest.json',
      new TextEncoder().encode('{"format":"whombat.backup-file/1"}\n'),
      1_791_000_000,
    ),
    tar.file(`files/${'ab'.repeat(32)}`, backupVectorPlaintext(600), 1_791_000_000),
    tar.finish(),
  ]);

  return {
    description:
      'Backup file container (CT-335). Plaintext of size n: byte i = (i * 31 + 7) mod 256. Keys: ikm = Argon2id(UTF-8 of the NFC password, salt, m KiB, t, p, 32), streamKey = HKDF-SHA256(ikm, -, "whombat.backup-file/1 stream", 32), keyCheck = HKDF-SHA256(ikm, -, "whombat.backup-file/1 key check", 16). Chunk i: XChaCha20-Poly1305(streamKey, noncePrefix ‖ i (7 bytes BE) ‖ last, aad = SHA-256(header)) = IETF ChaCha20-Poly1305(subkey = HChaCha20(streamKey, noncePrefix), 00000000 ‖ i ‖ last, same aad).',
    kdf: [
      { password: PASSWORD, salt: hex(SALT), params: SMALL, ikm: await ikm(PASSWORD, SALT, SMALL) },
      {
        name: 'the server’s defaults (BACKUP_KDF_DEFAULT)',
        password: PASSWORD,
        salt: hex(SALT),
        params: BACKUP_KDF_DEFAULT,
        ikm: await ikm(PASSWORD, SALT, BACKUP_KDF_DEFAULT),
      },
      {
        name: 'NFC: a decomposed é is the composed one',
        password: 'café au lait!',
        salt: hex(SALT),
        params: SMALL,
        ikm: await ikm('café au lait!', SALT, SMALL),
      },
    ],
    params: { password: PASSWORD, salt: hex(SALT), noncePrefix: hex(PREFIX), chunkBytes: CHUNK, kdf: SMALL },
    files,
    tampered,
    tar: {
      entries: [
        { name: 'manifest.json', size: 35, mtime: 1_791_000_000 },
        { name: `files/${'ab'.repeat(32)}`, size: 600, mtime: 1_791_000_000 },
      ],
      archive: hex(archive),
    },
  };
}
