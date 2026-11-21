import { builtin, type CatalogEntryInput } from './shared.js';

export const entry = {
  ...builtin(
    'device',
    'Device',
    'home',
    'A device on your network Whombat learned to read, and change within your limits.',
    null,
  ),
  // A device the scan finds (Modbus, CS-*): what the desk and Found on your network say of it (0.110, CT-702; DF-08).
  tagline: 'A device Whombat can learn to read',
  guide:
    'A device described by a profile Whombat wrote and the person switched on. Read it with its _read tool; each action is its own tool, within the limits the person set.',
} satisfies CatalogEntryInput;
