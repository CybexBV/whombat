/**
 * The phone's `SecureBox` (AP-717): sealed files in the app's private documents directory (`whombat-box/`, ciphertext
 * only), the key in expo-secure-store (Android Keystore / iOS Keychain,
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY`: not synced, not backed up), ChaCha20-Poly1305 natively when it matches the pure-JS
 * one (`nativeCrypto.ts`, AP-26, AP-890), else pure JS.
 */
import type { ICryptoInterface } from '@libp2p/noise';
import { defaultCrypto } from '@libp2p/noise/crypto';
import { getRandomBytes } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { checkedNativeCrypto } from '../managed/nativeCrypto';
import { secureStore } from '../managed/secureStore';
import { type BoxCrypto, createSecureBox, type SecureBox } from './secureBox';

/** The secure-store entry of the box's key (letters, digits, `.`, `-`, `_` only). */
const KEY_NAME = 'whombat.boxKey';

function boxCrypto(): BoxCrypto {
  const aead: ICryptoInterface = checkedNativeCrypto() ?? defaultCrypto;
  return aead as unknown as BoxCrypto;
}

const dir = () => new Directory(Paths.document, 'whombat-box');

let box: SecureBox | null = null;

/** The one box of this install, made on first use (the native AEAD's self-test runs then). */
export function deviceBox(): SecureBox {
  box ??= createBox();
  return box;
}

const createBox = (): SecureBox =>
  createSecureBox({
    crypto: boxCrypto(),
    random: (n) => getRandomBytes(n),
    keys: {
      get: () => secureStore.get(KEY_NAME),
      set: (value) => secureStore.set(KEY_NAME, value),
      remove: () => secureStore.remove(KEY_NAME),
    },
    files: {
      async read(name) {
        const file = new File(dir(), name);
        return file.exists ? await file.bytes() : null;
      },
      // Written next to it, then moved into place off the JS thread (AP-930): a save cut short (the process killed)
      // leaves the last copy, never half of one. expo-file-system writes only synchronously; the bytes go to the file
      // without a copy, which is quick — base64 for the legacy async write would cost the JS thread more.
      async write(name, bytes) {
        const d = dir();
        if (!d.exists) d.create({ intermediates: true, idempotent: true });
        const next = new File(d, `${name}.tmp`);
        next.write(bytes);
        await next.move(new File(d, name), { overwrite: true });
      },
      async remove(name) {
        const file = new File(dir(), name);
        if (file.exists) file.delete();
      },
      async removeAll() {
        const d = dir();
        if (d.exists) d.delete();
      },
    },
  });
