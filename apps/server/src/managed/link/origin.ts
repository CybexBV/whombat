/**
 * Where this box came from, and its part of Whombat Link's registration (docs/decisions/whombat-link.md LNK-01, LNK-03).
 *
 * Every box is the same image now: it makes its identity itself, is claimed on a page it served and gets Link's
 * features while Link runs. The one difference the runtime keeps is the box's origin: a box control registered before
 * Link (Home, the DEV stack box) was claimed through control and keeps that claim, its owner and devices, its hosted
 * passkeys and links to the hosted app. Provisioning's `device.json` says which (`applianceRoute` other than `local`).
 * Development and tests have no `device.json`; there the old edition switch stands in (a `community` box is local).
 */
import { readFileSync } from 'node:fs';
import { registrationSigningBytes } from '@whombat/control-contracts/device';
import { bytesToHex } from '@whombat/core';
import type { Identity } from '@whombat/secure-channel';
import { z } from 'zod';
import type { Config } from '../../config';

/** The appliance route of a box that made its identity itself (provisioning's `LocalRoute`). */
export const LOCAL_ROUTE = 'local';

/** `device.json` as provisioning writes it: the members a registration is made of (others ignored). */
export const DeviceFile = z.object({
  deviceId: z.string().min(1),
  env: z.string().min(1),
  applianceRoute: z.string().optional(),
  model: z.string().min(1),
  serial: z.string().min(1),
  contentPeerId: z.string().min(1),
  contentPublicKey: z.string().min(1),
  managementPublicKey: z.string().min(1),
  provisionedAt: z.number().int(),
});
export type DeviceFile = z.infer<typeof DeviceFile>;

const devices = new WeakMap<object, DeviceFile | null>();

/** The box's `device.json` (read once per configuration); null where there is none or it can't be read. */
export function deviceFileOf(config: Pick<Config, 'WHOMBAT_DEVICE_FILE'>): DeviceFile | null {
  if (devices.has(config)) return devices.get(config) ?? null;
  let device: DeviceFile | null = null;
  if (config.WHOMBAT_DEVICE_FILE) {
    try {
      device = DeviceFile.parse(JSON.parse(readFileSync(config.WHOMBAT_DEVICE_FILE, 'utf8')));
    } catch {
      device = null;
    }
  }
  devices.set(config, device);
  return device;
}

/**
 * Whether control registered this box before Link: claimed through control, reported to it, linked from the hosted app.
 * Not the edition: on a box the device file decides; development and tests without one fall back to the old switch.
 */
export function registeredAtControl(
  config: Pick<Config, 'WHOMBAT_DEVICE_FILE' | 'WHOMBAT_EDITION'>,
): boolean {
  const device = deviceFileOf(config);
  if (device) return (device.applianceRoute ?? LOCAL_ROUTE) !== LOCAL_ROUTE;
  return config.WHOMBAT_EDITION !== 'community';
}

/**
 * The content key's signature over the box's registration bytes (`contentProof` of `link.begin`): the manager holds
 * the management key and adds its own proof. Null without a device file.
 */
export function contentProofSigner(
  config: Pick<Config, 'WHOMBAT_DEVICE_FILE'>,
  identity: Pick<Identity, 'privateKey' | 'peerId'>,
): () => Promise<string | null> {
  return async () => {
    const device = deviceFileOf(config);
    if (!device || device.contentPeerId !== identity.peerId) return null;
    const bytes = registrationSigningBytes({
      env: device.env as never,
      hardwareSerial: device.serial as never,
      model: device.model as never,
      managementPublicKey: device.managementPublicKey,
      contentPeerId: device.contentPeerId,
      contentPublicKey: device.contentPublicKey,
      provisionedAt: device.provisionedAt,
    });
    return bytesToHex(await identity.privateKey.sign(bytes));
  };
}
