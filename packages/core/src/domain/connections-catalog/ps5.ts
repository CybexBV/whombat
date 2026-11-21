import { z } from 'zod';
import type { JsonObject } from '../common.js';
import {
  Ps5AutoloadArgs,
  Ps5EjectArgs,
  Ps5GameArgs,
  Ps5InstallArgs,
  Ps5LogArgs,
  Ps5NoArgs,
  Ps5RebootArgs,
  Ps5RunArgs,
  Ps5ShadowLogArgs,
  Ps5StopArgs,
  Ps5UpdateArgs,
  Ps5WebkitArgs,
} from '../ps5.js';
import { type CatalogEntryInput, type ConnectionToolDef, urlField } from './shared.js';

const tool = (
  name: string,
  title: string,
  description: string,
  schema: z.ZodType = Ps5NoArgs,
  write = false,
): ConnectionToolDef => ({
  name,
  title,
  description,
  access: write ? 'write' : 'read',
  ...(write ? { sensitive: true } : {}),
  inputSchema: z.toJSONSchema(schema) as JsonObject,
});

export const entry = {
  id: 'ps5',
  name: 'PlayStation 5',
  category: 'home',
  description: 'Your jailbroken PS5: homebrew, games, storage and updates you choose.',
  tagline: 'Your PS5’s homebrew and library',
  signIn: [{ kind: 'none', label: 'On your network' }],
  fields: [
    urlField(
      'http://192.168.1.20:8084',
      'Open WebKit Autoloader on your PS5 and leave Payload Manager running. Enter its address, usually port 8084.',
    ),
    {
      id: 'shadowmountPort',
      label: 'ShadowMountPlus port',
      kind: 'text',
      required: false,
      default: '10101',
      placeholder: '10101',
      help: 'On the same PS5. Leave this as 10101 unless you changed it.',
      validation: {
        pattern: '^(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$',
        message: 'Use a port from 1 to 65535.',
      },
    },
  ],
  transport: 'rest',
  baseUrl: '{url}',
  mcpPath: null,
  mcpMissingHint: null,
  check: { kind: 'request', method: 'GET', path: '/list_payloads', okJsonPath: 'self.running_version' },
  tools: [
    tool(
      'ps5_power_status',
      'Check remote reboot',
      'Check whether the reviewed SystemStateManager helper answers on port 9112 of this PS5. Returns its current pid for ps5_reboot. A missing helper does not mean the console is off.',
    ),
    tool(
      'ps5_enable_remote_reboot',
      'Enable remote reboot',
      'Download pinned SystemStateManager 1.0.0, verify its exact SHA-256 and ELF bytes, upload a new slot through Payload Manager and launch it. Adds no startup entry and does not reboot. Read ps5_power_status afterwards if readiness is not confirmed. Needs home-network access to port 9112.',
      Ps5NoArgs,
      true,
    ),
    tool(
      'ps5_reboot',
      'Reboot your PS5',
      'Ask SystemStateManager to reboot once. Read ps5_power_status first and pass expectedPid; refuses a changed helper or a known active storage job. Wait for any installer caching to finish on the console before requesting approval. Stops games and homebrew; the person must reopen WebKit Autoloader afterwards. An accepted request does not prove the reboot completed. Never automatically retry.',
      Ps5RebootArgs,
      true,
    ),
    tool(
      'ps5_status',
      'Look at your PS5',
      'Read everything at once: whether the console is awake or resting and its firmware, Payload Manager’s version, startup settings and how the last startup went, running processes, updates, games and storage. An unreachable service does not prove the console is switched off.',
    ),
    tool(
      'ps5_payloads',
      'See homebrew payloads',
      'List installed payload slots and versions; a payload uploaded by hand shows the version its file name carries. An installer downloaded here does not prove it was run.',
    ),
    tool(
      'ps5_processes',
      'See what’s running',
      'Read running processes and their reported memory use in MiB.',
    ),
    tool(
      'ps5_games',
      'See your game library',
      'Read ShadowMountPlus’s installed titles, versions, source availability and mount states. Does not scan or mount anything.',
    ),
    tool(
      'ps5_game_info',
      'Look at one game',
      'Read one title’s size, save data size, patch, add-ons and where it lives. Measuring takes a moment.',
      Ps5GameArgs,
    ),
    tool(
      'ps5_storage',
      'See storage space',
      'Read internal and USB storage capacity and available space, and ShadowMountPlus’s running job (an eject, a copy).',
    ),
    tool('ps5_logs', 'Read homebrew logs', 'Read recent Payload Manager log lines.', Ps5LogArgs),
    tool(
      'ps5_shadowmount_logs',
      'Read ShadowMountPlus logs',
      'Read the end of ShadowMountPlus’s debug log or the PS5’s kernel log, for a game that won’t mount or start.',
      Ps5ShadowLogArgs,
    ),
    tool(
      'ps5_payload_updates',
      'Check homebrew updates',
      'Compare every installed payload, including ones uploaded by hand, and Payload Manager itself (slot pldmgr) with the Official Repository: installed and available versions, checksums, whether it is in startup, and the firmware range a release names against the console’s firmware. Release notes come with each newer release.',
    ),
    tool(
      'ps5_update_payload',
      'Update a homebrew payload',
      'Replace one installed payload with the exact approved Official Repository version and checksum from ps5_payload_updates. Startup follows a payload uploaded by hand to its new copy and the old copy stays. Takes effect the next time it starts. Not for WebKit Autoloader or Payload Manager.',
      Ps5UpdateArgs,
      true,
    ),
    tool(
      'ps5_install_payload',
      'Download a homebrew payload',
      'Download an exact version and checksum of a payload that isn’t installed yet, or Payload Manager’s own update, from the Official Repository. Does not run it. To update an installed payload use ps5_update_payload.',
      Ps5InstallArgs,
      true,
    ),
    tool(
      'ps5_run_payload',
      'Run a homebrew payload',
      'Run one installed payload slot, and report whether the PS5 started it; verify its process or log afterwards. Never put an installer into startup.',
      Ps5RunArgs,
      true,
    ),
    tool(
      'ps5_update_webkit',
      'Update WebKit Autoloader',
      'Download and start the exact approved WebKit Autoloader installer, reusing an exact matching stored installer when available. It refreshes the PS5’s cached page and homescreen app. Refuses incompatible firmware. Wait for the PS5 to confirm caching finished before separately requesting a reboot, then reopen WebKit Autoloader. Never updates Sony firmware.',
      Ps5WebkitArgs,
      true,
    ),
    tool(
      'ps5_set_autoload',
      'Change homebrew startup',
      'Set payload slots, waits and startup delay. Read ps5_status first and pass its current config as expectedConfig. Refuses installers and keeps other settings.',
      Ps5AutoloadArgs,
      true,
    ),
    tool(
      'ps5_stop_payload',
      'Stop a homebrew payload',
      'Stop one running homebrew payload by its pid and name from ps5_processes. Refuses the loader, the jailbreak and Payload Manager.',
      Ps5StopArgs,
      true,
    ),
    tool(
      'ps5_rescan_games',
      'Look for new games',
      'Ask ShadowMountPlus to scan its folders and drives for games now. It waits while a game runs.',
      Ps5NoArgs,
      true,
    ),
    tool(
      'ps5_eject_usb',
      'Eject a USB drive',
      'Safely unmount an external USB drive from ps5_storage, so it can be unplugged once its job says completed. Refused while a running game uses it.',
      Ps5EjectArgs,
      true,
    ),
  ],
  request: null,
  guide:
    'Payload Manager on port 8084, optional ShadowMountPlus on 10101 and the optional reboot helper on 9112, all on this PS5. Each port needs home-network access. Use the typed tools; ShadowMountPlus reads use POST. Process memory is MiB. Homebrew disappears after reboot until the person opens WebKit Autoloader. Rest mode is normal. ps5_status distinguishes the console’s discovery from homebrew readiness; silence never proves it is off. For updates read ps5_payload_updates, check firmware support and release notes, then use ps5_update_payload or ps5_update_webkit. Exact repository metadata permits reusing a downloaded copy; it is not an independent hash of the stored file. Installer acceptance never proves caching finished or identifies the cached version. Wait for completion on the PS5 before a separate reboot approval. ps5_power_status checks the helper; ps5_enable_remote_reboot installs a pinned, hash-verified SystemStateManager without changing startup. ps5_reboot sends once with its current pid, reports acceptance only and must never be automatically retried. Reopen WebKit Autoloader afterwards. All writes ask first. Sony firmware, waking, shutdown, arbitrary URLs, shell, deleting games and Remote Play pairing are outside this connection.',
  sensitive: [],
  docsUrl: 'https://github.com/itsPLK/ps5-payload-manager',
  tokenUrl: null,
  handle: 'ps5',
  access: {
    read: 'See homebrew, running processes, games, logs and storage. Change nothing.',
    manage:
      'Also update and run homebrew, change startup, manage USB drives, enable remote reboot and reboot your PS5. Each change asks you first.',
  },
  discovery: {
    targets: [{ port: 8084, scheme: 'http' }],
    probes: [{ path: '/', status: [200], bodyPattern: '<title>Payload Manager v' }],
  },
} satisfies CatalogEntryInput;
