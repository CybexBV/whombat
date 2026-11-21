/**
 * The managed connector's secure-channel port filled with `@whombat/secure-channel` (contracts 0.3, MA-07):
 * the relay socket as a byte stream, the Noise XX initiator pinned to the appliance (full PeerId preferred;
 * the claim-card fingerprint is the fallback), and the plaintext byte stream the session frames go through.
 */
import {
  type ByteStream,
  type Identity,
  type InitiatorOptions,
  openInitiator,
  type SecureConnection,
  secureByteStream,
  type WebSocketLike,
  webSocketByteStream,
} from '@whombat/secure-channel';
import type { SecureChannelPort } from './connector';

export type { Identity } from '@whombat/secure-channel';

/**
 * `crypto`: an optional Noise primitive implementation (`@libp2p/noise` `ICryptoInterface`) — e.g. native
 * ChaCha20-Poly1305 on Android (AP-26). Default: the library's pure-JS primitives.
 */
export function secureChannelPort(
  options: { crypto?: InitiatorOptions['crypto'] } = {},
): SecureChannelPort<Identity> {
  return {
    byteStream: (socket, options) =>
      webSocketByteStream(socket as unknown as WebSocketLike, {
        maxMessageBytes: options.maxMessageBytes,
      }),
    openInitiator: (o) =>
      openInitiator({
        stream: o.stream as ByteStream,
        identity: o.identity,
        ...(o.expectedAppliancePeerId !== undefined && {
          expectedAppliancePeerId: o.expectedAppliancePeerId,
        }),
        ...(o.expectedApplianceFingerprint !== undefined && {
          expectedApplianceFingerprint: o.expectedApplianceFingerprint,
        }),
        ...(options.crypto && { crypto: options.crypto }),
      }),
    secureByteStream: (connection) => secureByteStream(connection as SecureConnection),
  };
}
