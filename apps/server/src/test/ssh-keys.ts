/**
 * SSH key pairs for tests. ssh2's `generateKeyPairSync` makes an ed25519 key that neither ssh2 nor OpenSSH can read
 * about once in 300 (test-speed.md TS-03): a fake server with such a host key fails to start. Production makes its keys
 * with `node:crypto` (vault/ssh-keys.ts); only tests use ssh2's generator, through this.
 */
import ssh2 from 'ssh2';

const { utils } = ssh2;

type KeyType = 'rsa' | 'ecdsa' | 'ed25519';
interface KeyOptions {
  bits?: number;
  comment?: string;
  passphrase?: string;
  cipher?: string;
  rounds?: number;
}
interface KeyPair {
  private: string;
  public: string;
}
/** ssh2's generator without its per-type overloads. */
const generate = utils.generateKeyPairSync as (type: KeyType, options: KeyOptions) => KeyPair;

/** A pair from ssh2's generator whose private key reads back (with its passphrase, if it has one). */
export function sshKeyPair(type: KeyType, options: KeyOptions = {}): KeyPair {
  for (let attempt = 0; attempt < 20; attempt++) {
    const pair = generate(type, options);
    if (!(utils.parseKey(pair.private, options.passphrase) instanceof Error)) return pair;
  }
  throw new Error(`ssh2 made no readable ${type} key in 20 attempts`);
}
