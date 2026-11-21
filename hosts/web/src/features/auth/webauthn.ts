// WebAuthn (passkeys) glue between the hub's JSON (go-webauthn, base64url
// binary fields) and the browser's credential API (ArrayBuffers).
//
// Options: the begin endpoints return go-webauthn's `{publicKey: {...}}`
// wrapper (a bare options object is accepted too). The native
// `PublicKeyCredential.parse*OptionsFromJSON` is used when the browser has it;
// otherwise challenge, user.id and the credential descriptor ids are decoded
// by hand. Results: `credential.toJSON()` when available, else a manual
// serialization in the WebAuthn Level 3 JSON shape the hub's
// `protocol.Parse*Response` reads.

import { t } from '../../lib/i18n';

type Json = Record<string, unknown>;

// ------------------------------------------------------------------ base64url

/** base64url (padding optional; standard base64 accepted too) -> ArrayBuffer. */
export function b64urlToBuffer(s: string): ArrayBuffer {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** ArrayBuffer or view -> unpadded base64url. */
export function bufferToB64url(buf: ArrayBuffer | ArrayBufferView): string {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function isObj(v: unknown): v is Json {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function bin(v: unknown, field: string): ArrayBuffer {
  if (typeof v === 'string') return b64urlToBuffer(v);
  if (v instanceof ArrayBuffer) return v;
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice().buffer;
  throw new TypeError(`WebAuthn options: ${field} is not base64url`);
}

/** Inner options object of go-webauthn's `{publicKey: {...}, mediation?}` wrapper (or the object itself). */
export function unwrapOptions(json: unknown): Json {
  if (!isObj(json)) throw new TypeError('WebAuthn options: expected an object');
  const inner = json.publicKey;
  return isObj(inner) ? inner : json;
}

function descriptors(list: unknown, field: string): PublicKeyCredentialDescriptor[] | undefined {
  if (list == null) return undefined;
  if (!Array.isArray(list)) throw new TypeError(`WebAuthn options: ${field} is not a list`);
  return list.map((d, i) => {
    if (!isObj(d)) throw new TypeError(`WebAuthn options: ${field}[${i}] is not an object`);
    return { ...d, type: (d.type as PublicKeyCredentialType | undefined) ?? 'public-key', id: bin(d.id, `${field}[${i}].id`) } as PublicKeyCredentialDescriptor;
  });
}

/** Drop null / undefined members: the browser's dictionaries reject null for most of them. */
function compact(o: Json): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

/** Manual conversion of request options JSON (exported for tests). */
export function requestOptionsFromJSON(json: unknown): PublicKeyCredentialRequestOptions {
  const o = compact(unwrapOptions(json));
  const allow = descriptors(o.allowCredentials, 'allowCredentials');
  return { ...o, challenge: bin(o.challenge, 'challenge'), ...(allow ? { allowCredentials: allow } : {}) } as PublicKeyCredentialRequestOptions;
}

/** Manual conversion of creation options JSON (exported for tests). */
export function creationOptionsFromJSON(json: unknown): PublicKeyCredentialCreationOptions {
  const o = compact(unwrapOptions(json));
  if (!isObj(o.user)) throw new TypeError('WebAuthn options: user is missing');
  const exclude = descriptors(o.excludeCredentials, 'excludeCredentials');
  return {
    ...o,
    challenge: bin(o.challenge, 'challenge'),
    user: { ...o.user, id: bin(o.user.id, 'user.id') },
    ...(exclude ? { excludeCredentials: exclude } : {}),
  } as unknown as PublicKeyCredentialCreationOptions;
}

interface PKCStatic {
  parseRequestOptionsFromJSON?: (o: unknown) => PublicKeyCredentialRequestOptions;
  parseCreationOptionsFromJSON?: (o: unknown) => PublicKeyCredentialCreationOptions;
}

function pkcStatic(): PKCStatic | null {
  return typeof PublicKeyCredential === 'undefined' ? null : (PublicKeyCredential as unknown as PKCStatic);
}

/** Begin JSON -> `navigator.credentials.get({publicKey})` options (native parser first). */
export function toRequestOptions(json: unknown): PublicKeyCredentialRequestOptions {
  const parse = pkcStatic()?.parseRequestOptionsFromJSON;
  if (parse) {
    try {
      return parse.call(PublicKeyCredential, compact(unwrapOptions(json)));
    } catch {
      // Older or stricter implementation: fall back to the manual conversion.
    }
  }
  return requestOptionsFromJSON(json);
}

/** Begin JSON -> `navigator.credentials.create({publicKey})` options (native parser first). */
export function toCreationOptions(json: unknown): PublicKeyCredentialCreationOptions {
  const parse = pkcStatic()?.parseCreationOptionsFromJSON;
  if (parse) {
    try {
      return parse.call(PublicKeyCredential, compact(unwrapOptions(json)));
    } catch {
      // fall through
    }
  }
  return creationOptionsFromJSON(json);
}

// ------------------------------------------------------------------ results

export interface AssertionJSON {
  id: string;
  rawId: string;
  type: string;
  authenticatorAttachment: string | null;
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle: string | null };
  clientExtensionResults: Json;
}

export interface AttestationJSON {
  id: string;
  rawId: string;
  type: string;
  authenticatorAttachment: string | null;
  response: { clientDataJSON: string; attestationObject: string; transports: string[] };
  clientExtensionResults: Json;
}

/** The subset of PublicKeyCredential used here (structural, so tests can pass plain objects). */
export interface CredentialLike {
  id: string;
  rawId: ArrayBuffer;
  type: string;
  authenticatorAttachment?: string | null;
  response: {
    clientDataJSON: ArrayBuffer;
    authenticatorData?: ArrayBuffer;
    signature?: ArrayBuffer;
    userHandle?: ArrayBuffer | null;
    attestationObject?: ArrayBuffer;
    getTransports?: () => string[];
  };
  getClientExtensionResults?: () => unknown;
  toJSON?: () => unknown;
}

function extensionResults(c: CredentialLike): Json {
  try {
    const r = c.getClientExtensionResults?.();
    return isObj(r) ? r : {};
  } catch {
    return {};
  }
}

/** Manual serialization (exported for tests). */
export function serializeCredential(c: CredentialLike): AssertionJSON | AttestationJSON {
  const base = {
    id: c.id,
    rawId: bufferToB64url(c.rawId),
    type: c.type,
    authenticatorAttachment: c.authenticatorAttachment ?? null,
    clientExtensionResults: extensionResults(c),
  };
  const r = c.response;
  if (r.attestationObject) {
    let transports: string[] = [];
    try {
      transports = r.getTransports?.() ?? [];
    } catch {
      transports = [];
    }
    return { ...base, response: { clientDataJSON: bufferToB64url(r.clientDataJSON), attestationObject: bufferToB64url(r.attestationObject), transports } };
  }
  if (!r.authenticatorData || !r.signature) throw new TypeError('Unexpected credential response');
  return {
    ...base,
    response: {
      clientDataJSON: bufferToB64url(r.clientDataJSON),
      authenticatorData: bufferToB64url(r.authenticatorData),
      signature: bufferToB64url(r.signature),
      userHandle: r.userHandle && r.userHandle.byteLength ? bufferToB64url(r.userHandle) : null,
    },
  };
}

/** PublicKeyCredential -> JSON for the hub: native toJSON() when present and sane, else manual. */
export function credentialToJSON(c: CredentialLike): unknown {
  if (typeof c.toJSON === 'function') {
    try {
      const j = c.toJSON();
      if (isObj(j) && typeof j.id === 'string' && isObj(j.response)) return j;
    } catch {
      // Some extensions wrap the credential with a broken toJSON: serialize by hand.
    }
  }
  return serializeCredential(c);
}

// ------------------------------------------------------------------ ceremonies

/** WebAuthn is usable in this browser context (secure context + API present). */
export function webauthnSupported(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && typeof PublicKeyCredential !== 'undefined' && !!navigator.credentials?.get;
}

/** Sign-in: begin JSON in, assertion JSON out. */
export async function getAssertion(beginJson: unknown, signal?: AbortSignal): Promise<unknown> {
  const publicKey = toRequestOptions(beginJson);
  const cred = await navigator.credentials.get({ publicKey, signal });
  if (!cred) throw new DOMException('No passkey was chosen.', 'NotAllowedError');
  return credentialToJSON(cred as unknown as CredentialLike);
}

/** Registration: begin JSON in, attestation JSON out. */
export async function createCredential(beginJson: unknown, signal?: AbortSignal): Promise<unknown> {
  const publicKey = toCreationOptions(beginJson);
  const cred = await navigator.credentials.create({ publicKey, signal });
  if (!cred) throw new DOMException('No passkey was created.', 'NotAllowedError');
  return credentialToJSON(cred as unknown as CredentialLike);
}

/** True for an IPv4 or IPv6 literal host name (WebAuthn needs a domain). */
export function isIpHost(hostname: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true;
  return hostname.includes(':') || (hostname.startsWith('[') && hostname.endsWith(']'));
}

/** Readable message for a failed passkey ceremony. */
export function passkeyErrorMessage(err: unknown, hostname: string = typeof location !== 'undefined' ? location.hostname : ''): string {
  const name = err instanceof DOMException || err instanceof Error ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
      return t('The passkey request was cancelled or timed out.');
    case 'AbortError':
      return t('The passkey request was cancelled.');
    case 'InvalidStateError':
      return t('This passkey is already registered for your account.');
    case 'NotSupportedError':
      return t('This browser or authenticator does not support the requested passkey type.');
    case 'SecurityError':
      return isIpHost(hostname)
        ? t("Passkeys need a host name. This page is open at the IP address {hostname}; open Rackoon by its host name (the hub's public URL) to use passkeys.", { hostname })
        : t('The browser refused the passkey request for this address. Open Rackoon at the hub’s public URL (https with a host name).');
  }
  if (err instanceof Error && err.message) return err.message;
  return t('The passkey request failed.');
}
