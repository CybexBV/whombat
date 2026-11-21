/**
 * The session endpoint's secure channel (MA-07): `@whombat/secure-channel`'s Noise XX responder with the appliance
 * content identity, over a relay byte stream, using Node's crypto (`nodeNoiseCrypto`). The client pinned our
 * PeerId; we learn and authenticate theirs (`remotePeerId`), which the session maps to an enrolled endpoint.
 * Session frames then flow through `secureByteStream` (records ≤ 65514 bytes, any frame split). A channel at its
 * rekey limit fails sends with `RekeyRequiredError`: the session closes cleanly and the client reconnects with a
 * fresh handshake.
 */
import { acceptResponder, type ByteStream, type Identity, secureByteStream } from '@whombat/secure-channel';
import { nodeNoiseCrypto } from '@whombat/secure-channel/node';
import type { SecureMessageChannel, SecureResponder } from '../ports';

export const HANDSHAKE_TIMEOUT_MS = 10_000;

export function secureResponder(identity: Identity): SecureResponder {
  return async (stream: ByteStream): Promise<SecureMessageChannel> => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        stream.abort(new Error('handshake timeout'));
        reject(new Error('handshake timeout'));
      }, HANDSHAKE_TIMEOUT_MS);
      timer.unref?.();
    });
    const connection = await Promise.race([
      acceptResponder({ stream, identity, crypto: nodeNoiseCrypto }),
      timeout,
    ]).finally(() => clearTimeout(timer));
    const bytes = secureByteStream(connection);
    return {
      remotePeerId: connection.remotePeerId,
      remotePublicKey: connection.remotePublicKey,
      async send(message) {
        if (!bytes.write(message)) await bytes.drained();
      },
      receive: () => bytes.read(),
      close: () => bytes.close(),
      abort: (reason) => bytes.abort(reason ?? new Error('session closed')),
    };
  };
}
