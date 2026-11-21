import type { CallWords } from './index';

const text = (args: Readonly<Record<string, unknown>>, key: string) => String(args[key] ?? '').slice(0, 180);

export const PS5_CALL_WORDS: CallWords = {
  ask(tool, args) {
    switch (tool) {
      case 'ps5_enable_remote_reboot':
        return 'install and start SystemStateManager 1.0.0 for remote reboot on your PS5';
      case 'ps5_reboot':
        return 'reboot your PS5';
      case 'ps5_install_payload':
        return `download ${text(args, 'id')} ${text(args, 'version')} on your PS5`;
      case 'ps5_update_payload':
        return `update ${text(args, 'id')} to ${text(args, 'version')} on your PS5`;
      case 'ps5_update_webkit':
        return `update WebKit Autoloader to ${text(args, 'version')} on your PS5`;
      case 'ps5_run_payload':
        return `run ${text(args, 'slot')} on your PS5`;
      case 'ps5_set_autoload':
        return 'change homebrew startup on your PS5';
      case 'ps5_stop_payload':
        return `stop ${text(args, 'name')} on your PS5`;
      case 'ps5_rescan_games':
        return 'look for new games on your PS5';
      case 'ps5_eject_usb':
        return `eject the USB drive at ${text(args, 'mountPoint')} on your PS5`;
      default:
        return null;
    }
  },
  note(tool) {
    if (tool === 'ps5_enable_remote_reboot')
      return 'This adds a small helper while homebrew is running. It doesn’t reboot or change startup.';
    if (tool === 'ps5_reboot')
      return 'This stops games and homebrew. Wait for any update or caching to finish first. You’ll need to open WebKit Autoloader again afterwards.';
    if (tool === 'ps5_update_webkit')
      return 'After the PS5 confirms caching finished, you’ll need to reboot it and open WebKit Autoloader.';
    if (tool === 'ps5_install_payload') return 'This downloads the payload. It doesn’t run it.';
    if (tool === 'ps5_update_payload')
      return 'The new version takes effect the next time it starts. A copy you uploaded yourself stays, so you can go back.';
    if (tool === 'ps5_run_payload')
      return 'The loader’s answer confirms it accepted the payload; its log tells us whether it finished.';
    if (tool === 'ps5_stop_payload') return 'It starts again with homebrew startup if it’s in it.';
    if (tool === 'ps5_eject_usb') return 'Unplug the drive only once Whombat says it’s ejected.';
    return null;
  },
};
