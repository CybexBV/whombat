/**
 * The browser's passkeys (`PasskeyPlatform`, passkeys.md AP-791): `navigator.credentials` with WebAuthn's JSON. Where
 * the browser has `PublicKeyCredential.parse…OptionsFromJSON` and `toJSON()` they are used; otherwise the few binary
 * members are converted here (base64url ↔ `ArrayBuffer`), which is all `@simplewebauthn/browser` would do for us.
 *
 * A dismissed prompt, a timeout or an abort (`NotAllowedError`, `AbortError`) is `PasskeyCancelled`: the screen says
 * nothing. An authenticator that already holds a passkey for this Whombat (`InvalidStateError` on create) is
 * `exists`; a page whose origin doesn't fit the RP ID (`SecurityError`) or a browser without WebAuthn is `unsupported`.
 */
import {
  type PasskeyAssertionJSON,
  PasskeyCancelled,
  type PasskeyCreationOptionsJSON,
  type PasskeyCredentialDescriptorJSON,
  PasskeyError,
  type PasskeyPlatform,
  type PasskeyRegistrationJSON,
  type PasskeyRequestOptionsJSON,
  passkeyPrfBytes,
} from '@whombat/client/managed';
import { base64urlDecode, base64urlEncode } from '@whombat/protocol';

/** The browser speaks WebAuthn at all: a passkey on this computer, a security key or a phone nearby (hybrid). */
export function webAuthnExists(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function';
}

const buffer = (text: string): ArrayBuffer => {
  const bytes = base64urlDecode(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};
/**
 * Bytes as base64url. A buffer may come from another realm (a password-manager extension's content script), where
 * `instanceof ArrayBuffer` is false: views by `ArrayBuffer.isView`, anything else read as a buffer (AP-805).
 */
const text = (data: ArrayBuffer | ArrayBufferView | null | undefined): string | undefined => {
  if (!data) return undefined;
  try {
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data as ArrayBuffer);
    return bytes.length ? base64urlEncode(bytes) : undefined;
  } catch {
    return undefined;
  }
};

const descriptor = (d: PasskeyCredentialDescriptorJSON): PublicKeyCredentialDescriptor => ({
  id: buffer(d.id),
  type: 'public-key',
  ...(d.transports && { transports: d.transports as AuthenticatorTransport[] }),
});

interface JsonAware {
  parseCreationOptionsFromJSON?(options: unknown): PublicKeyCredentialCreationOptions;
  parseRequestOptionsFromJSON?(options: unknown): PublicKeyCredentialRequestOptions;
  isConditionalMediationAvailable?(): Promise<boolean>;
}
const statics = (): JsonAware & typeof PublicKeyCredential =>
  window.PublicKeyCredential as JsonAware & typeof PublicKeyCredential;

/**
 * The PRF extension's inputs as buffers (Whombat backup-passkey.md): WebAuthn's JSON carries them as base64url, and not
 * every browser's own parser turns them into bytes. Other extensions stay as they are.
 */
function prfInputs(
  extensions: Record<string, unknown> | undefined,
): AuthenticationExtensionsClientInputs | undefined {
  const prf = (extensions?.prf as { eval?: { first?: unknown; second?: unknown } } | undefined)?.eval;
  if (!extensions || typeof prf?.first !== 'string')
    return extensions as AuthenticationExtensionsClientInputs;
  return {
    ...extensions,
    prf: {
      eval: {
        first: buffer(prf.first),
        ...(typeof prf.second === 'string' && { second: buffer(prf.second) }),
      },
    },
  } as AuthenticationExtensionsClientInputs;
}

/** WebAuthn's creation options from JSON (the browser's own parser when it has one). */
export function creationOptions(o: PasskeyCreationOptionsJSON): PublicKeyCredentialCreationOptions {
  const parse = statics()?.parseCreationOptionsFromJSON;
  const extensions = prfInputs(o.extensions);
  if (parse) {
    const { extensions: _json, ...rest } = o;
    const parsed = parse.call(window.PublicKeyCredential, rest as never);
    return extensions ? { ...parsed, extensions } : parsed;
  }
  return {
    ...(o as unknown as PublicKeyCredentialCreationOptions),
    challenge: buffer(o.challenge),
    user: { ...o.user, id: buffer(o.user.id) },
    ...(o.excludeCredentials && { excludeCredentials: o.excludeCredentials.map(descriptor) }),
    ...(extensions && { extensions }),
  } as PublicKeyCredentialCreationOptions;
}

/** WebAuthn's request options from JSON. */
export function requestOptions(o: PasskeyRequestOptionsJSON): PublicKeyCredentialRequestOptions {
  const parse = statics()?.parseRequestOptionsFromJSON;
  const extensions = prfInputs(o.extensions);
  if (parse) {
    const { extensions: _json, ...rest } = o;
    const parsed = parse.call(window.PublicKeyCredential, rest as never);
    return extensions ? { ...parsed, extensions } : parsed;
  }
  return {
    ...(o as unknown as PublicKeyCredentialRequestOptions),
    challenge: buffer(o.challenge),
    ...(o.allowCredentials && { allowCredentials: o.allowCredentials.map(descriptor) }),
    ...(extensions && { extensions }),
  } as PublicKeyCredentialRequestOptions;
}

type Attachment = 'platform' | 'cross-platform' | null;

/** A created credential as `RegistrationResponseJSON`. */
export function registrationJSON(credential: PublicKeyCredential): PasskeyRegistrationJSON {
  // Our own encoding from the buffers first: an extension's `toJSON` may be missing, throw or write buffers as `{}`
  // (AP-805); the browser's only when the buffers can't be read.
  const r0 = credential.response as AuthenticatorAttestationResponse | undefined;
  if (!text(r0?.clientDataJSON) || !text(r0?.attestationObject))
    return jsonOf(credential) as PasskeyRegistrationJSON;
  const r = credential.response as AuthenticatorAttestationResponse & {
    getTransports?: () => string[];
    getPublicKeyAlgorithm?: () => number;
    getPublicKey?: () => ArrayBuffer | null;
    getAuthenticatorData?: () => ArrayBuffer;
  };
  const publicKey = text(r.getPublicKey?.());
  const authenticatorData = text(r.getAuthenticatorData?.());
  return {
    id: credential.id,
    rawId: text(credential.rawId) ?? credential.id,
    type: 'public-key',
    response: {
      clientDataJSON: text(r.clientDataJSON) as string,
      attestationObject: text(r.attestationObject) as string,
      ...(authenticatorData && { authenticatorData }),
      ...(r.getTransports && { transports: r.getTransports() }),
      ...(r.getPublicKeyAlgorithm && { publicKeyAlgorithm: r.getPublicKeyAlgorithm() }),
      ...(publicKey && { publicKey }),
    },
    clientExtensionResults: extensionResults(credential),
    authenticatorAttachment: (credential.authenticatorAttachment as Attachment) ?? null,
  };
}

/** An assertion as `AuthenticationResponseJSON`. */
export function assertionJSON(credential: PublicKeyCredential): PasskeyAssertionJSON {
  const r = credential.response as AuthenticatorAssertionResponse;
  // As registrationJSON: the buffers first, the credential's own `toJSON` only when they can't be read (AP-805).
  if (!text(r?.clientDataJSON) || !text(r?.signature)) return jsonOf(credential) as PasskeyAssertionJSON;
  const userHandle = text(r.userHandle);
  return {
    id: credential.id,
    rawId: text(credential.rawId) ?? credential.id,
    type: 'public-key',
    response: {
      clientDataJSON: text(r.clientDataJSON) as string,
      authenticatorData: text(r.authenticatorData) as string,
      signature: text(r.signature) as string,
      ...(userHandle && { userHandle }),
    },
    clientExtensionResults: extensionResults(credential),
    authenticatorAttachment: (credential.authenticatorAttachment as Attachment) ?? null,
  };
}

/** The credential's own JSON (`toJSON`), or its plain fields when it has none. */
function jsonOf(credential: PublicKeyCredential): unknown {
  const own = (credential as { toJSON?: () => unknown }).toJSON;
  return typeof own === 'function' ? own.call(credential) : credential;
}

/**
 * The credential's extension outputs, the PRF's bytes as base64url (as WebAuthn's JSON and the phone have them): the
 * shared sign-in reads the backup key's PRF output from there and drops it before anything is sent.
 */
function extensionResults(credential: PublicKeyCredential): Record<string, unknown> {
  let out: Record<string, unknown>;
  try {
    out = (credential.getClientExtensionResults?.() ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
  const prf = out.prf as { enabled?: unknown; results?: { first?: unknown; second?: unknown } } | undefined;
  if (!prf?.results) return out;
  const firstBytes = passkeyPrfBytes(prf.results.first);
  const secondBytes = passkeyPrfBytes(prf.results.second);
  const first = firstBytes ? base64urlEncode(firstBytes) : null;
  const second = secondBytes ? base64urlEncode(secondBytes) : null;
  return {
    ...out,
    prf: {
      ...(typeof prf.enabled === 'boolean' && { enabled: prf.enabled }),
      ...(first && { results: { first, ...(second && { second }) } }),
    },
  };
}

/** The browser's refusals in this module's words. */
export function passkeyFailure(error: unknown): Error {
  const name = (error as { name?: string } | null)?.name;
  // The browser's own error stays as the cause: the screen says the short sentence, the box's log says this.
  const cause = { cause: error };
  if (name === 'NotAllowedError' || name === 'AbortError') return new PasskeyCancelled(cause);
  if (name === 'InvalidStateError') return new PasskeyError('exists', undefined, cause);
  if (name === 'SecurityError' || name === 'NotSupportedError')
    return new PasskeyError('unsupported', undefined, cause);
  return error instanceof PasskeyError || error instanceof PasskeyCancelled
    ? error
    : new PasskeyError('failed', undefined, cause);
}

/**
 * A sign-in's failure as the sign-in page says it (AP-804). The email field's autofill (a conditional request, made on
 * load) that fails before the person picked a passkey — no passkey provider, `NotSupportedError`, control not
 * reachable — is said nowhere: nobody asked, and “Sign in with a passkey” still says why when clicked.
 */
export function signInFailure(error: unknown, request: { conditional?: boolean }, picked: boolean): unknown {
  return request.conditional && !picked ? new PasskeyCancelled() : error;
}

export function webPasskeys(): PasskeyPlatform {
  return {
    async isAvailable() {
      if (!webAuthnExists()) return false;
      try {
        return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
      } catch {
        return false;
      }
    },
    async supportsConditional() {
      if (!webAuthnExists()) return false;
      try {
        return (await statics().isConditionalMediationAvailable?.()) ?? false;
      } catch {
        return false;
      }
    },
    async create(options) {
      if (!webAuthnExists()) throw new PasskeyError('unsupported');
      try {
        const credential = await navigator.credentials.create({ publicKey: creationOptions(options) });
        if (!credential) throw new PasskeyCancelled();
        return registrationJSON(credential as PublicKeyCredential);
      } catch (error) {
        throw passkeyFailure(error);
      }
    },
    async get(options, request = {}) {
      if (!webAuthnExists()) throw new PasskeyError('unsupported');
      try {
        const credential = await navigator.credentials.get({
          publicKey: requestOptions(options),
          ...(request.conditional && { mediation: 'conditional' as CredentialMediationRequirement }),
          ...(request.signal && { signal: request.signal }),
        });
        if (!credential) throw new PasskeyCancelled();
        return assertionJSON(credential as PublicKeyCredential);
      } catch (error) {
        throw passkeyFailure(error);
      }
    },
    prf: webPrf,
    // WebAuthn's Signal API (Chrome 132 and later, Safari 26): the page's host is the RP ID, as for every passkey here.
    async forget(credentialId) {
      await signals()?.signalUnknownCredential?.({ rpId: window.location.hostname, credentialId });
    },
    async keepOnly(userId, credentialIds) {
      await signals()?.signalAllAcceptedCredentials?.({
        rpId: window.location.hostname,
        userId,
        allAcceptedCredentialIds: [...credentialIds],
      });
    },
  };
}

/** The Signal API's statics, where the browser has them. */
interface SignalAware {
  signalUnknownCredential?(options: { rpId: string; credentialId: string }): Promise<void>;
  signalAllAcceptedCredentials?(options: {
    rpId: string;
    userId: string;
    allAcceptedCredentialIds: string[];
  }): Promise<void>;
}
const signals = (): SignalAware | null =>
  webAuthnExists() ? (window.PublicKeyCredential as unknown as SignalAware) : null;

/**
 * The passkey's WebAuthn PRF output for `salt` (Whombat backup-options.md: it locks the recovery kit), from whichever
 * of `credentialIds` this browser has. A fresh random challenge: nothing is signed for anyone, the assertion itself is
 * thrown away. Null where the browser, the passkey or its manager doesn't offer PRF (no `prf.results.first`).
 */
export async function webPrf(input: {
  credentialIds: readonly string[];
  salt: Uint8Array;
}): Promise<{ credentialId: string; output: Uint8Array | null; userHandle?: string } | null> {
  if (!webAuthnExists()) throw new PasskeyError('unsupported');
  const challenge = new Uint8Array(32);
  crypto.getRandomValues(challenge);
  const first = input.salt.buffer.slice(
    input.salt.byteOffset,
    input.salt.byteOffset + input.salt.byteLength,
  ) as ArrayBuffer;
  let credential: PublicKeyCredential | null;
  try {
    credential = (await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials: input.credentialIds.map((id) => ({ id: buffer(id), type: 'public-key' as const })),
        userVerification: 'required',
        extensions: { prf: { eval: { first } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
  } catch (error) {
    throw passkeyFailure(error);
  }
  if (!credential) throw new PasskeyCancelled();
  // The raw outputs: `extensionResults` writes the PRF's bytes as base64url for the JSON.
  let raw: { prf?: { results?: { first?: unknown } } } = {};
  try {
    raw = (credential.getClientExtensionResults?.() ?? {}) as typeof raw;
  } catch {
    // none
  }
  const bytes = passkeyPrfBytes(raw.prf?.results?.first);
  const userHandle = text((credential.response as AuthenticatorAssertionResponse | undefined)?.userHandle);
  return {
    credentialId: text(credential.rawId) ?? credential.id,
    output: bytes,
    ...(userHandle && { userHandle }),
  };
}
