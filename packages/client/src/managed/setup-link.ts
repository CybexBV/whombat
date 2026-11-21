/**
 * The links that set up a device for a Whombat it doesn't know yet (AP-64): an add-a-device link from a device that's
 * already set up. It names the Whombat's identity (`p`), so the device pins it from the link, never from the directory.
 * Pasted on the phone's pairing page or either app's “Set up this device” page.
 */
import { parseAddDeviceLink } from './pin';

export type SetupLink = { kind: 'add'; device: string; peerId: string };

export function parseSetupLink(text: string, uiOrigins: readonly string[]): SetupLink | null {
  const add = parseAddDeviceLink(text, uiOrigins);
  return add ? { kind: 'add', ...add } : null;
}
