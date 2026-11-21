/**
 * The appliance identity pin (MA-24, AP-63…AP-69). A device connects to a Whombat only with a PeerId it pinned from a
 * party that already trusts that Whombat: the claim (CPace-confirmed), a recovery kit that names the identity, an
 * add-a-device link made by an enrolled device, or the box's own screen (its CPace-confirmed
 * sign-in, BX-03). The directory (control's list) never writes or changes a pin; it is only compared with it:
 *
 * - pinned and equal to the directory → go on;
 * - pinned and different → hard stop (“This Whombat’s identity has changed”), nothing is sent to the appliance;
 * - not pinned → “Set up this device” (an add-a-device link, the recovery kit or the box's screen),
 *   never a connection with the directory's PeerId except for the screen sign-in, which pins only once the box's tag
 *   proved that identity (BX-03).
 *
 * A link or kit that names an identity other than the directory's is a hard stop too, before any secret is sent.
 * Pure: shared by the web and the phone, unit-tested in this package.
 */
import { PeerIdString } from '@whombat/protocol/session';
import { applianceLink, journeyDevice, uiLinkParts } from './links';
import type { KnownAppliance } from './registry';

/**
 * Who vouched for a pinned identity. `legacy`: pinned before AP-63 (possibly from the directory); kept as is.
 * `passkey`: the Whombat a passkey names in its user handle (PK-01, PK-04, passkeys.md AP-786). `screen`: the
 * directory's identity, kept only once the box's screen sign-in tag matched (BX-03, signin-at-box-web.md AP-3503).
 */
export type PinSource =
  | 'claim'
  | 'kit'
  | 'add-link'
  | 'passkey'
  | 'screen'
  /**
   * The box's own page (HE-50; hermes-engine-app.md AP-5322): the box that served the page named itself (`GET
   * /v1/direct`), pinned on first use — the page's code comes from the same place, so nothing better vouches for it.
   */
  | 'box'
  | 'legacy';

export function isPeerId(value: string | null | undefined): value is string {
  return typeof value === 'string' && PeerIdString.safeParse(value).success;
}

/** Opening a Whombat from the list or a link that names it (MR-45): what this device's pin says. */
export type OpenDecision =
  | { kind: 'proceed'; known: KnownAppliance }
  | { kind: 'changed'; known: KnownAppliance; directory: string }
  | { kind: 'unpinned' };

export function openDecision(
  known: KnownAppliance | null | undefined,
  directoryPeerId: string,
): OpenDecision {
  if (!known) return { kind: 'unpinned' };
  if (known.peerId !== directoryPeerId) return { kind: 'changed', known, directory: directoryPeerId };
  return { kind: 'proceed', known };
}

/**
 * A link or a kit that may name the identity (`named`), checked against this device's pin and the directory:
 *
 * - `changed`: this device's pin differs from the directory — the same hard stop as opening it;
 * - `mismatch`: the link or kit names another identity than the directory — hard stop before any secret is sent;
 * - `missing`: it names none and nothing is pinned — refused (an old link, a kit made before AP-65);
 * - `pin`: go on with `peerId` (`isNew`: store it with `source`; else the existing pin stays as it is).
 */
export type TrustDecision =
  | { kind: 'pin'; peerId: string; isNew: boolean }
  | { kind: 'changed'; pinned: string; directory: string }
  | { kind: 'mismatch'; named: string; directory: string }
  | { kind: 'missing' };

export function trustDecision(input: {
  pinned: string | null;
  named: string | null;
  directory: string;
}): TrustDecision {
  const { pinned, named, directory } = input;
  if (pinned && pinned !== directory) return { kind: 'changed', pinned, directory };
  if (named && named !== directory) return { kind: 'mismatch', named, directory };
  if (pinned) return { kind: 'pin', peerId: pinned, isNew: false };
  if (named) return { kind: 'pin', peerId: named, isNew: true };
  return { kind: 'missing' };
}

/** The record a new pin makes (not enrolled yet: the journey that follows lets this device in). */
export function pinnedRecord(input: {
  device: string;
  orgId: string;
  name: string | null;
  peerId: string;
  source: PinSource;
  accountId?: string | null;
}): KnownAppliance {
  return {
    device: input.device,
    orgId: input.orgId,
    name: input.name,
    peerId: input.peerId,
    pinSource: input.source,
    enrolled: false,
    kitPending: false,
    ...(input.accountId ? { accountId: input.accountId } : {}),
  };
}

/* The add-a-device link (AP-66) ------------------------------------------------------------------------------ */

export const ADD_DEVICE_PATH = /^\/appliances\/([^/]+)\/add\/?$/;

/**
 * What an enrolled device shows under Settings · Devices → “Add a device”: `<hosted UI>/appliances/<device>/add#p=<PeerId>`.
 * It names the Whombat and its identity; it is not a credential (the pairing approval still is).
 */
export function addDeviceLink(uiOrigin: string, device: string, peerId: string): string {
  return `${applianceLink(uiOrigin, device, '/add')}#p=${peerId}`;
}

/** The phone's own form of the same link. */
export function addDeviceAppLink(device: string, peerId: string): string {
  return `whombat://appliances/${encodeURIComponent(device)}/add#p=${peerId}`;
}

/** An add-a-device link, from the hosted UI or `whombat://appliances/<device>/add#p=…`; null for anything else. */
export function parseAddDeviceLink(
  text: string,
  uiOrigins: readonly string[],
): { device: string; peerId: string } | null {
  const parts = uiLinkParts(text, uiOrigins);
  const device = parts ? journeyDevice(parts.path, ADD_DEVICE_PATH) : null;
  const peerId = parts?.fragment.get('p') ?? null;
  return device && isPeerId(peerId) ? { device, peerId } : null;
}
