/**
 * Devices Whombat doesn't support yet (docs/decisions/one-whombat.md ONE-16…ONE-19; one-whombat-devices.md): the
 * commands the pipeline registers, and what the Home registry gets once at load (the Things and Needs you sources, the
 * `device.set` undoer).
 */
import { registerDeviceSources } from './home';
import { recordDeviceChange } from './run';
import { DEVICE_COMMANDS } from './skills';
import { registerDeviceUndo } from './undo';

registerDeviceSources();
registerDeviceUndo();

export { readDevicesNow, startDeviceReader, stopDeviceReader } from './home';

/** Registered with the pipeline (commands/index.ts). */
export const DEVICES_COMMANDS = [...DEVICE_COMMANDS, recordDeviceChange];
