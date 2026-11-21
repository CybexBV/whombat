import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { KeyStoreError } from '../errors.js';
import { deserializeIdentity, type Identity, serializeIdentity } from '../identity.js';
import { assertKeyName, type KeyStore } from '../keystore.js';

/**
 * Node file key store: one file per identity, `<dir>/<name>.key`, holding the libp2p protobuf private key.
 * The directory is created 0700. A new key is written 0600 to a temp file, fsynced, and published atomically:
 * `link(tmp, file)` (fails if the file exists, so concurrent creators cannot overwrite each other; review L-4)
 * or, with `replace`, `rename(tmp, file)`; then the directory is fsynced. Reading opens with `O_NOFOLLOW` and
 * checks the opened descriptor (no stat/open race): a symlink, a non-regular file, another owner, or any
 * group/other permission fails closed.
 * (On the appliance the directory is `/persist/identity`, owned by the runtime user; MA-03/MA-12.)
 */
export class FileKeyStore implements KeyStore {
  constructor(private readonly dir: string) {}

  private path(name: string): string {
    assertKeyName(name);
    return join(this.dir, `${name}.key`);
  }

  async get(name: string): Promise<Identity | undefined> {
    const file = this.path(name);
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return undefined;
      if (code === 'ELOOP') throw new KeyStoreError(`${file} is not a regular file (symlink)`);
      throw new KeyStoreError(`cannot open ${file}`, { cause: err });
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new KeyStoreError(`${file} is not a regular file`);
      if ((info.mode & 0o077) !== 0) {
        throw new KeyStoreError(`${file} has mode ${(info.mode & 0o777).toString(8)}; expected 600`);
      }
      if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
        throw new KeyStoreError(`${file} is not owned by the current user`);
      }
      if (info.size > 4096) throw new KeyStoreError(`${file} is too large for a key`);
      return deserializeIdentity(new Uint8Array(await handle.readFile()));
    } finally {
      await handle.close();
    }
  }

  async put(name: string, identity: Identity, options: { replace?: boolean } = {}): Promise<void> {
    const file = this.path(name);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const dirInfo = await stat(this.dir);
    if ((dirInfo.mode & 0o022) !== 0) throw new KeyStoreError(`${this.dir} is group/world writable`);
    const bytes = serializeIdentity(identity);
    const tmp = join(this.dir, `.${name}.${randomUUID()}.tmp`);
    try {
      const handle = await open(
        tmp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.chmod(0o600);
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (options.replace) {
        await rename(tmp, file);
      } else {
        try {
          await link(tmp, file);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
          const existing = await this.get(name);
          if (existing?.peerId === identity.peerId) return;
          throw new KeyStoreError(`identity ${name} already exists`);
        }
      }
      const dirHandle = await open(this.dir, constants.O_RDONLY);
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    } finally {
      await rm(tmp, { force: true });
    }
  }

  async delete(name: string): Promise<void> {
    await rm(this.path(name), { force: true });
  }
}
