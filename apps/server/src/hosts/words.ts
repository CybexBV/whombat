/**
 * The Servers calls in words (one-whombat-servers.md ONE-DH21; CLAUDE.md “Agents and automations talk like people”):
 * what an approval says Whombat wants to do (“restart web on pve-02”), the one sentence it posts after a yes ran it
 * (“Restarting web on pve-02 now.”), and the one it posts when a task the call started ends (proxmox.md PX-05: “The
 * backup of web on pve-02 is done.”). Written by the server from the call's own arguments and the service's answer,
 * never by the agent; no task ids, logs or tool names.
 */

import { HOST_SELF_SERVER_POWER_TEXT, type HostServerDetail } from '@whombat/core';
import { appAskPhrase, appCardNote, appListWords, appNames } from './app-words';
import { knownServer, runsThisWhombat } from './self';
import { packageTaskCodeText, updatePhrase, waitingUpdates } from './updates';

type Args = Readonly<Record<string, unknown>>;

const named = (args: Args, key: string, fallback: string) => {
  const v = args[key];
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : fallback;
};

const cap = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

/** A storage in words: Unraid's VM folders by what they hold (`folder:isos` → “the ISO folder”, 0.84). */
const storageWords = (v: string) =>
  v === 'folder:isos' ? 'the ISO folder' : v === 'folder:domains' ? 'the VM folder' : v;

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** When a backup volume was made, from its name (PBS `backup/vm/101/2026-10-16T02:00:00Z`, vzdump's `…-2026_10_16-…`). */
export function backupDate(volume: string): Date | null {
  const m =
    /(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(volume) ??
    /(\d{4})_(\d{2})_(\d{2})-(\d{2})_(\d{2})/.exec(volume) ??
    // An Incus backup Whombat named (`whombat-20261016-0200`, IU-04), a libvirt backup's folder (`20261016-020000`).
    /(?:^|\D)(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(?:\d{2})?(?!\d)/.exec(volume);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])));
  return Number.isFinite(d.getTime()) ? d : null;
}

/** A backup in words: “yesterday’s backup”, “today’s backup”, “the 16 October backup”, or “a backup”. */
export function backupNoun(volume: string | null | undefined, now: Date = new Date()): string {
  const d = volume ? backupDate(volume) : null;
  if (!d) return 'a backup';
  const day = (x: Date) => Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate());
  const days = Math.round((day(now) - day(d)) / 86_400_000);
  if (days === 0) return 'today’s backup';
  if (days === 1) return 'yesterday’s backup';
  const year = d.getUTCFullYear() === now.getUTCFullYear() ? '' : ` ${d.getUTCFullYear()}`;
  return `the ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year} backup`;
}

/** A Proxmox schedule in words (“04:00” → “every day at 04:00”); anything else as Proxmox writes it. */
export function scheduleWords(schedule: string): string {
  const s = schedule.trim();
  const days: Record<string, string> = {
    mon: 'Monday',
    tue: 'Tuesday',
    wed: 'Wednesday',
    thu: 'Thursday',
    fri: 'Friday',
    sat: 'Saturday',
    sun: 'Sunday',
  };
  if (/^\d{1,2}:\d{2}$/.test(s)) return `every day at ${s.padStart(5, '0')}`;
  if (s === 'daily') return 'every day';
  if (s === 'hourly') return 'every hour';
  if (s === 'weekly') return 'every week';
  const every = /^\*\/(\d+)$/.exec(s);
  if (every) return `every ${every[1]} minutes`;
  const one = /^(mon|tue|wed|thu|fri|sat|sun)\s+(\d{1,2}:\d{2})$/.exec(s);
  if (one) return `on ${days[one[1] as string]}s at ${(one[2] as string).padStart(5, '0')}`;
  const range = /^(mon|tue|wed|thu|fri|sat|sun)\.\.(mon|tue|wed|thu|fri|sat|sun)\s+(\d{1,2}:\d{2})$/.exec(s);
  if (range)
    return `${days[range[1] as string]} to ${days[range[2] as string]} at ${(range[3] as string).padStart(5, '0')}`;
  return `on the schedule “${s.slice(0, 40)}”`;
}

/** The file a volume names (`local:iso/debian-13.iso` → `debian-13.iso`). */
export const volumeFile = (volume: string) => volume.split(/[:/]/).pop() || volume;

/**
 * A call in three phrasings: what the approval asks (“restart web on pve-02”), what Whombat is doing once a yes ran it
 * when the server works on it for a while (“Restarting web on pve-02”), and what it did when it is done at once
 * (“Protected yesterday’s backup of web on pve-02”).
 */
interface Phrase {
  ask: string;
  doing?: string;
  done?: string;
}

function phrase(tool: string, args: Args, now: Date): Phrase | null {
  const server = named(args, 'server', 'a server');
  const guestName = named(args, 'guest', 'a guest');
  const guest = `${guestName} on ${server}`;
  const action = named(args, 'action', '');
  switch (tool) {
    case 'guest_power': {
      const words: Record<string, [string, string]> = {
        start: ['start', 'Starting'],
        stop: ['stop', 'Stopping'],
        shutdown: ['shut down', 'Shutting down'],
        reboot: ['restart', 'Restarting'],
        pause: ['pause', 'Pausing'],
        resume: ['resume', 'Resuming'],
      };
      const [ask, doing] = words[action] ?? ['change', 'Changing'];
      return { ask: `${ask} ${guest}`, doing: `${doing} ${guest}` };
    }
    case 'guest_config_set': {
      const del = Array.isArray(args.delete) ? args.delete : [];
      const set = args.set && typeof args.set === 'object' ? Object.keys(args.set) : [];
      if (del.some((k) => typeof k === 'string' && /^unused\d+$/.test(k)) && args.confirm === true)
        return {
          ask: `delete an unused disk of ${guest} for good`,
          done: `Deleted an unused disk of ${guest}`,
        };
      if (Array.isArray(args.revert) && args.revert.length && !del.length && !set.length)
        return {
          ask: `drop the changes of ${guest} that wait for a restart`,
          done: `Dropped the changes of ${guest} that waited for a restart`,
        };
      return { ask: `change the settings of ${guest}`, done: `Changed the settings of ${guest}` };
    }
    case 'guest_snapshot': {
      const name = named(args, 'name', '');
      if (action === 'create')
        return { ask: `take a snapshot of ${guest}`, doing: `Taking a snapshot of ${guest}` };
      if (action === 'restore')
        return name
          ? {
              ask: `put ${guest} back to its snapshot ${name}`,
              doing: `Putting ${guest} back to its snapshot ${name}`,
            }
          : { ask: `put ${guest} back to a snapshot`, doing: `Putting ${guest} back to a snapshot` };
      return name
        ? {
            ask: `delete the snapshot ${name} of ${guest}`,
            doing: `Deleting the snapshot ${name} of ${guest}`,
          }
        : { ask: `delete a snapshot of ${guest}`, doing: `Deleting a snapshot of ${guest}` };
    }
    case 'guest_migrate': {
      const target = named(args, 'target', 'another node');
      return {
        ask: `move ${guestName} from ${server} to ${target}`,
        doing: `Moving ${guestName} from ${server} to ${target}`,
      };
    }
    case 'guest_create': {
      const kind = args.kind === 'container' ? 'a container' : 'a VM';
      const name = named(args, 'name', 'a new guest');
      return {
        ask: `create ${kind} called ${name} on ${server}`,
        doing: `Creating ${kind} called ${name} on ${server}`,
      };
    }
    case 'guest_clone': {
      const name = named(args, 'name', 'a copy');
      return { ask: `clone ${guest} as ${name}`, doing: `Cloning ${guest} as ${name}` };
    }
    case 'guest_template':
      return { ask: `turn ${guest} into a template`, doing: `Turning ${guest} into a template` };
    case 'guest_delete':
      return { ask: `delete ${guest}`, doing: `Deleting ${guest}` };
    case 'guest_disk': {
      const disk = named(args, 'disk', 'a disk');
      if (action === 'move') {
        const to = named(args, 'storage', 'another storage');
        return {
          ask: `move the disk ${disk} of ${guest} to ${to}`,
          doing: `Moving the disk ${disk} of ${guest} to ${to}`,
        };
      }
      const size = named(args, 'size', '');
      const how = size.startsWith('+') ? ` by ${size.slice(1)}` : size ? ` to ${size}` : '';
      return {
        ask: `grow the disk ${disk} of ${guest}${how}`,
        doing: `Growing the disk ${disk} of ${guest}${how}`,
      };
    }
    case 'guest_backup': {
      const backup = backupNoun(typeof args.backup === 'string' ? args.backup : null, now);
      const of = typeof args.guest === 'string' && args.guest.trim() ? ` of ${guest}` : ` on ${server}`;
      switch (action) {
        case 'create':
          return { ask: `back up ${guest}`, doing: `Backing up ${guest}` };
        case 'restore':
          return args.as_new === true
            ? {
                ask: `restore a copy of ${typeof args.guest === 'string' ? guestName : 'a guest'} on ${server} from ${backup}`,
                doing: `Restoring a copy on ${server} from ${backup}`,
              }
            : {
                ask: `restore ${typeof args.guest === 'string' ? guestName : 'its guest'} on ${server} from ${backup}`,
                doing: `Restoring ${typeof args.guest === 'string' ? guestName : 'the guest'} on ${server} from ${backup}`,
              };
        case 'protect':
          return { ask: `protect ${backup}${of}`, done: `Protected ${backup}${of}` };
        case 'unprotect':
          return { ask: `stop protecting ${backup}${of}`, done: `Stopped protecting ${backup}${of}` };
        case 'notes':
          return { ask: `change the notes of ${backup}${of}`, done: `Changed the notes of ${backup}${of}` };
        default:
          return { ask: `delete ${backup}${of}`, done: `Deleted ${backup}${of}` };
      }
    }
    case 'backup_job_set': {
      const on = `a backup job on ${server}`;
      switch (action) {
        case 'create': {
          const when =
            typeof args.schedule === 'string' && args.schedule.trim()
              ? ` that runs ${scheduleWords(args.schedule)}`
              : '';
          return {
            ask: `add a backup job on ${server}${when}`,
            done: `Added a backup job on ${server}${when}`,
          };
        }
        case 'update':
          return { ask: `change ${on}`, done: `Changed ${on}` };
        case 'pause':
          return { ask: `pause ${on}`, done: `Paused ${on}` };
        case 'resume':
          return { ask: `resume ${on}`, done: `Resumed ${on}` };
        case 'delete':
          return { ask: `delete ${on}`, done: `Deleted ${on}` };
        case 'run':
          return { ask: `run ${on} now`, doing: `Running ${on}` };
        case 'add_guest':
          return { ask: `add ${guestName} to ${on}`, done: `Added ${guestName} to ${on}` };
        case 'remove_guest':
          return { ask: `take ${guestName} out of ${on}`, done: `Took ${guestName} out of ${on}` };
        default:
          return { ask: `change ${on}`, done: `Changed ${on}` };
      }
    }
    case 'storage_content': {
      const storage = storageWords(named(args, 'storage', 'a storage'));
      if (action === 'download') {
        const file = named(args, 'filename', '') || volumeFile(named(args, 'url', 'a file'));
        return {
          ask: `download ${file} to ${storage} on ${server}`,
          doing: `Downloading ${file} to ${storage} on ${server}`,
        };
      }
      if (action === 'get_template') {
        const t = named(args, 'template', 'a container template');
        return {
          ask: `download ${t} to ${storage} on ${server}`,
          doing: `Downloading ${t} to ${storage} on ${server}`,
        };
      }
      const file = volumeFile(named(args, 'volume', 'a file'));
      return {
        ask: `delete ${file} from ${storage} on ${server}`,
        done: `Deleted ${file} from ${storage} on ${server}`,
      };
    }
    case 'task_stop': {
      const what = taskTypeWords(named(args, 'task', ''));
      return { ask: `stop ${what} on ${server}`, done: `Stopped ${what} on ${server}` };
    }
    case 'guest_firewall_set': {
      const fw = `the firewall of ${guest}`;
      const rule = args.rule && typeof args.rule === 'object' ? (args.rule as Record<string, unknown>) : null;
      switch (action) {
        case 'enable':
          return { ask: `turn on ${fw}`, done: `Turned on ${fw}` };
        case 'disable':
          return { ask: `turn off ${fw}`, done: `Turned off ${fw}` };
        case 'options':
          return {
            ask: `change the firewall options of ${guest}`,
            done: `Changed the firewall options of ${guest}`,
          };
        case 'add_rule':
          return { ask: `add a firewall rule to ${guest}`, done: `Added a firewall rule to ${guest}` };
        case 'update_rule':
          if (rule && Object.keys(rule).length === 1 && typeof rule.enable === 'boolean')
            return rule.enable
              ? { ask: `turn on a firewall rule of ${guest}`, done: `Turned on a firewall rule of ${guest}` }
              : {
                  ask: `turn off a firewall rule of ${guest}`,
                  done: `Turned off a firewall rule of ${guest}`,
                };
          return { ask: `change a firewall rule of ${guest}`, done: `Changed a firewall rule of ${guest}` };
        case 'delete_rule':
          return { ask: `remove a firewall rule of ${guest}`, done: `Removed a firewall rule of ${guest}` };
        default:
          return { ask: `move a firewall rule of ${guest}`, done: `Moved a firewall rule of ${guest}` };
      }
    }
    case 'guest_ha':
      return action === 'remove'
        ? { ask: `take ${guest} out of high availability`, done: `Took ${guest} out of high availability` }
        : {
            ask: `keep ${guest} running with high availability`,
            done: `${guest} has high availability now`,
          };
    case 'guest_replication':
      return action === 'delete'
        ? { ask: `stop a replication of ${guest}`, done: `Stopped a replication of ${guest}` }
        : {
            ask: `replicate ${guest} to ${named(args, 'target', 'another node')}`,
            done: `${guest} is replicated to ${named(args, 'target', 'another node')} from now on`,
          };
    case 'server_power': {
      // The server this Whombat runs on says so in the question (IU-02); the card adds HOST_SELF_SERVER_POWER_TEXT.
      const which = runsThisWhombat(args.server) ? `${server}, the server this Whombat runs on` : server;
      return action === 'shutdown'
        ? { ask: `shut down ${which}`, doing: `Shutting down ${server}` }
        : { ask: `reboot ${which}`, doing: `Rebooting ${server}` };
    }
    case 'guest_rename': {
      const name = named(args, 'name', 'a new name');
      return { ask: `rename ${guest} to ${name}`, doing: `Renaming ${guest} to ${name}` };
    }
    case 'guest_move': {
      const where = moveWhere(args);
      return { ask: `move ${guest} to ${where}`, doing: `Moving ${guest} to ${where}` };
    }
    case 'guest_publish': {
      const snap = named(args, 'snapshot', '');
      const of = snap ? `its snapshot ${snap}` : guest;
      return snap
        ? { ask: `make an image of ${guest} from ${of}`, doing: `Making an image of ${guest} from ${of}` }
        : { ask: `make an image of ${guest}`, doing: `Making an image of ${guest}` };
    }
    case 'incus_image': {
      if (action === 'download') {
        const alias = named(args, 'alias', 'an image');
        return {
          ask: `download the image ${alias} to ${server}`,
          doing: `Downloading the image ${alias} to ${server}`,
        };
      }
      if (action === 'refresh')
        return { ask: `refresh an image on ${server}`, doing: `Refreshing an image on ${server}` };
      return { ask: `delete an image on ${server}`, doing: `Deleting an image on ${server}` };
    }
    case 'incus_profile_set': {
      const profile = `the profile ${named(args, 'profile', '')} on ${server}`.replace('  ', ' ');
      if (action === 'create') return { ask: `add ${profile}`, done: `Added ${profile}` };
      if (action === 'delete') return { ask: `delete ${profile}`, done: `Deleted ${profile}` };
      return { ask: `change ${profile}`, done: `Changed ${profile}` };
    }
    case 'storage_volume': {
      const volume = named(args, 'volume', 'a volume');
      const pool = named(args, 'pool', 'a pool');
      if (action === 'create')
        return {
          ask: `add the volume ${volume} to ${pool} on ${server}`,
          done: `Added the volume ${volume} to ${pool} on ${server}`,
        };
      if (action === 'resize') {
        const size = named(args, 'size', '');
        const to = size ? ` to ${size}` : '';
        return {
          ask: `grow the volume ${volume} on ${server}${to}`,
          done: `Grew the volume ${volume} on ${server}${to}`,
        };
      }
      return {
        ask: `delete the volume ${volume} on ${server}`,
        done: `Deleted the volume ${volume} on ${server}`,
      };
    }
    case 'unraid_array': {
      const disk = named(args, 'disk', 'all');
      const disks = disk === 'all' ? `every disk of ${server}` : `${disk} on ${server}`;
      switch (action) {
        case 'start':
          return { ask: `start the array of ${server}`, doing: `Starting the array of ${server}` };
        case 'stop':
          return { ask: `stop the array of ${server}`, doing: `Stopping the array of ${server}` };
        case 'parity_check':
          return args.correct === true
            ? {
                ask: `check parity on ${server} and write corrections`,
                doing: `Checking parity on ${server} with corrections`,
              }
            : { ask: `check parity on ${server}`, doing: `Checking parity on ${server}` };
        case 'parity_pause':
          return {
            ask: `pause the parity check on ${server}`,
            doing: `Pausing the parity check on ${server}`,
          };
        case 'parity_resume':
          return {
            ask: `resume the parity check on ${server}`,
            doing: `Resuming the parity check on ${server}`,
          };
        case 'parity_cancel':
          return {
            ask: `cancel the parity check on ${server}`,
            doing: `Cancelling the parity check on ${server}`,
          };
        case 'spin_up':
          return { ask: `spin up ${disks}`, doing: `Spinning up ${disks}` };
        case 'spin_down':
          return { ask: `spin down ${disks}`, doing: `Spinning down ${disks}` };
        case 'mover':
          return { ask: `run the mover on ${server}`, doing: `Running the mover on ${server}` };
        default:
          return typeof args.notification === 'string' && args.notification
            ? { ask: `archive a notification on ${server}`, done: `Archived a notification on ${server}` }
            : {
                ask: `archive the notifications on ${server}`,
                done: `Archived the notifications on ${server}`,
              };
      }
    }
    case 'unraid_plugins': {
      if (action === 'check')
        return {
          ask: `check the plugins on ${server} for updates`,
          doing: `Checking the plugins on ${server} for updates`,
        };
      const plugin = pluginName(args);
      return plugin
        ? {
            ask: `update the plugin ${plugin} on ${server}`,
            doing: `Updating the plugin ${plugin} on ${server}`,
          }
        : { ask: `update the plugins on ${server}`, doing: `Updating the plugins on ${server}` };
    }
    case 'container_update':
      return action === 'check'
        ? {
            ask: `check the containers on ${server} for updates`,
            doing: `Checking the containers on ${server} for updates`,
          }
        : { ask: `update ${guest}`, doing: `Updating ${guest}` };
    case 'app_update':
      return appAskPhrase(args);
    case 'guest_autostart':
      return args.on === false
        ? { ask: `stop ${guest} starting with its server`, done: `${guest} no longer starts with its server` }
        : { ask: `have ${guest} start with its server`, done: `${guest} starts with its server now` };
    // A Proxmox server's backups on a NAS (backup-places.md BPL-12).
    case 'backup_place_nfs':
      return {
        ask: `share a folder on ${server} for backups`,
        done: `${server} shares a folder for backups now`,
      };
    case 'proxmox_storage_add':
      return { ask: `add backup storage to ${server}`, done: `${server} has its backup storage now` };
    case 'alert_snooze':
      return { ask: 'snooze an alert', done: 'Snoozed the alert' };
    case 'server_command':
      return { ask: `run “${named(args, 'command', 'a command')}” on ${server}` };
    // The server's operating-system updates (server-updates.md SWU-08): the count Whombat last read there, if any.
    case 'server_update':
      return updatePhrase(
        args,
        server,
        waitingUpdates(knownServer(args.server)?.id ?? server, now.getTime()),
      );
    // A Mac's screen and apps (macos-servers.md): what the step does, never the text it types.
    case 'mac_screen':
      return macScreenPhrase(action, server, named(args, 'keys', 'keys'));
    case 'mac_ui':
      return macUiPhrase(args, action, server);
    // Only a card the person presses (server-signin.md SI-10); words for when they set it to ask first.
    case 'server_add': {
      const address = named(args, 'address', 'a server');
      return { ask: `add ${address} as a server`, done: `Here’s the card to add ${address} as a server` };
    }
    default:
      return null;
  }
}

/** `mac_screen`'s step in words: “click on Studio’s screen”, “type on Studio’s screen”, “unlock Studio’s screen”. */
function macScreenPhrase(action: string, server: string, keys: string): Phrase {
  const on = `${server}’s screen`;
  switch (action) {
    case 'click':
      return { ask: `click on ${on}`, done: `Clicked on ${on}` };
    case 'double_click':
      return { ask: `double-click on ${on}`, done: `Double-clicked on ${on}` };
    case 'right_click':
      return { ask: `right-click on ${on}`, done: `Right-clicked on ${on}` };
    case 'drag':
      return { ask: `drag on ${on}`, done: `Dragged on ${on}` };
    case 'scroll':
      return { ask: `scroll on ${on}`, done: `Scrolled on ${on}` };
    case 'type':
      return { ask: `type on ${on}`, done: `Typed on ${on}` };
    case 'keys':
      return { ask: `press ${keys} on ${server}`, done: `Pressed ${keys} on ${server}` };
    case 'unlock':
      return { ask: `unlock ${on}`, done: `Unlocked ${on}` };
    case 'password':
      return {
        ask: `enter the Mac’s password on ${server}`,
        done: `Entered the Mac’s password on ${server}`,
      };
    default:
      return { ask: `use ${on}`, done: `Used ${on}` };
  }
}

/**
 * `mac_ui`'s step in words: “press “Allow” on Studio”, “choose File → Save… on Studio”, “choose “Play” for “Mara’s
 * Keys” on Studio”.
 */
function macUiPhrase(args: Args, action: string, server: string): Phrase {
  const name = named(args, 'name', 'it');
  const app = named(args, 'app', 'the app');
  switch (action) {
    case 'press':
      return { ask: `press “${name}” on ${server}`, done: `Pressed “${name}” on ${server}` };
    case 'set':
      return args.name
        ? { ask: `fill in “${name}” on ${server}`, done: `Filled in “${name}” on ${server}` }
        : { ask: `type on ${server}’s screen`, done: `Typed on ${server}’s screen` };
    case 'menu': {
      const path = Array.isArray(args.path)
        ? args.path
            .filter((p): p is string => typeof p === 'string')
            .map((p) => p.slice(0, 40))
            .join(' → ')
        : 'a menu item';
      return { ask: `choose ${path} on ${server}`, done: `Chose ${path} on ${server}` };
    }
    case 'focus':
      return { ask: `bring ${app} forward on ${server}`, done: `Brought ${app} forward on ${server}` };
    case 'open': {
      const target = named(args, 'target', 'it');
      return target === 'accessibility'
        ? {
            ask: `open the Accessibility settings on ${server}`,
            done: `Opened the Accessibility settings on ${server}`,
          }
        : { ask: `open ${target} on ${server}`, done: `Opened ${target} on ${server}` };
    }
    case 'action': {
      const perform = named(args, 'perform', 'an action');
      return {
        ask: `choose “${perform}” for “${name}” on ${server}`,
        done: `Chose “${perform}” for “${name}” on ${server}`,
      };
    }
    case 'quit':
      return { ask: `quit ${app} on ${server}`, done: `Quit ${app} on ${server}` };
    default:
      return { ask: `use the apps on ${server}`, done: `Used the apps on ${server}` };
  }
}

/** Where `guest_move` takes a guest, in words. */
function moveWhere(args: Args): string {
  const pool = named(args, 'pool', '');
  const project = named(args, 'project', '');
  if (pool && project) return `the pool ${pool} in the project ${project}`;
  if (project) return `the project ${project}`;
  return pool ? `the pool ${pool}` : 'another pool';
}

/** A plugin's name from its file (`unassigned.devices.plg` → `unassigned.devices`), or null for all of them. */
function pluginName(args: Args): string | null {
  const plugin = named(args, 'plugin', 'all');
  return plugin === 'all' ? null : plugin.replace(/\.plg$/, '');
}

/**
 * What an approval card adds after the ask: a server that runs this Whombat goes down with it (IU-02), or may stop it
 * for a moment while its updates install (SWU-08).
 */
export function serversNoteWords(tool: string, args: Args): string | null {
  if (tool === 'app_update') return appCardNote(args);
  if (!runsThisWhombat(args.server)) return null;
  if (tool === 'server_power') return HOST_SELF_SERVER_POWER_TEXT;
  if (tool === 'server_update' && args.action === 'install') return SELF_SERVER_UPDATE_TEXT;
  return null;
}

/** SWU-08: an upgrade on the server this Whombat runs on can restart its database (SWU-S05). */
export const SELF_SERVER_UPDATE_TEXT =
  'This Whombat runs there and may stop for a moment while they install.';

/** A Proxmox task's kind in words, from its id (`UPID:node:…:vzdump:101:…`). */
export function taskTypeWords(task: string): string {
  const type = task.startsWith('UPID:') ? (task.split(':')[5] ?? '') : '';
  const words: Record<string, string> = {
    vzdump: 'the backup',
    qmclone: 'the clone',
    vzclone: 'the clone',
    qmrestore: 'the restore',
    vzrestore: 'the restore',
    qmigrate: 'the move',
    vzmigrate: 'the move',
    download: 'the download',
    aptldr: 'the download',
    qmcreate: 'the new VM',
    vzcreate: 'the new container',
    qmmove: 'the disk move',
    move_volume: 'the disk move',
  };
  return words[type] ?? 'a task';
}

/** What a Servers call does, in words (the approval's title and card: “restart web on pve-02”). */
export function serversAskWords(tool: string, args: Args, now: Date = new Date()): string | null {
  return phrase(tool, args, now)?.ask ?? null;
}

/**
 * What happened after a yes ran it, in one sentence. A command's own answer is what it printed, which only the agent
 * that asked can read and explain: null, so it is woken with the output (chat-asks.md CA-02, home-redesign.md HR-04).
 */
export function serversDoneWords(
  tool: string,
  args: Args,
  result: { ok: true; isError: boolean; content: string } | { ok: false; message: string },
  now: Date = new Date(),
): string | null {
  if (tool === 'server_command') return null;
  const p = phrase(tool, args, now);
  if (!p) return null;
  // The hub's and the platform's own words are for admins: the plain reason when one is known, else nothing.
  if (!result.ok) {
    const why = taskReason(result.message);
    return why ? `I couldn’t ${p.ask}: ${why}.` : `I couldn’t ${p.ask}.`;
  }
  if (result.isError) {
    let said = '';
    try {
      said = String((JSON.parse(result.content) as { error?: unknown }).error ?? '');
    } catch {
      said = '';
    }
    const why = taskReason(said);
    return why ? `I couldn’t ${p.ask}: ${why}.` : `I couldn’t ${p.ask}.`;
  }
  if (tool === 'server_power' && runsThisWhombat(args.server)) {
    const server = named(args, 'server', 'the server');
    return named(args, 'action', '') === 'shutdown'
      ? `${p.doing} now. This Whombat goes down too and stays off until someone turns ${server} on again.`
      : `${p.doing} now. This Whombat goes down too and comes back with it.`;
  }
  // Done at once, or running on the server for a few seconds or minutes after this.
  if (p.done) return `${p.done}.`;
  return `${p.doing ?? cap(p.ask)} now.`;
}

/* Tasks that end later (PX-05) ------------------------------------------------------------------------------------ */

/**
 * Whether a call starts a task Whombat follows to its end (task-feedback.md TF-05, TF-10): the calls with task words.
 * Its card shows it running and the agent that asked is woken when it ends (TF-12), not with the call's result.
 */
export function serversStartsTask(tool: string, args: Args): boolean {
  return serversTaskWords(tool, args, { server: named(args, 'server', 'the server') }) !== null;
}

/**
 * Whether Whombat says what a call did after a yes itself instead of waking the agent with its result (task-feedback.md
 * TF-S10): a restart or shutdown of the server this Whombat runs on, which takes the agent down with it.
 */
export function serversSaysItself(tool: string, args: Args): boolean {
  return tool === 'server_power' && runsThisWhombat(args.server);
}

/**
 * A task a Servers call started, in words: `what` it is (“The backup of web on pve-02”), what Whombat was `doing`
 * (“Backing up web on pve-02”), and the sentence for a clean end when “… is done.” doesn't read well.
 */
export interface TaskWords {
  what: string;
  doing: string;
  ok?: string;
  /**
   * What a clean end adds once the server's report shows it (IU-07): parity errors, plugin or container updates; or, for
   * a Check or Install of the server's updates (SWU-08), the whole message from the task's result and the report.
   */
  after?: 'parity' | 'plugins' | 'containers' | 'updates.check' | 'updates.install' | 'apps';
  /** The sentence for an end with a code (a package task: the lock still held, the time limit). */
  codes?: Partial<Record<'busy' | 'timeout', string>>;
  /** An Install's named packages (its message names them). */
  packages?: string[];
  /** The server's name in messages, where the message is written after the task (SWU-08). */
  server?: string;
}

/** What a call resolved, for its task's words: the server's id, the guest's own name and the rest it found. */
export interface TaskNames {
  server: string;
  /** The server's name in messages (“BlackBox”), when not its id. */
  label?: string | null;
  /** Whose task: `incus` for an Incus backup's or restore's words. */
  platform?: string | null;
  guest?: string | null;
  /** A new guest's or copy's name, a job's name, a file's name. */
  name?: string | null;
  /** The backup in words (“yesterday’s backup”). */
  backup?: string | null;
}

/**
 * The words of a task a call started, from the names the call resolved (the guest's own name, the server's id), or
 * null when the call starts no task worth a message.
 */
export function serversTaskWords(tool: string, args: Args, names: TaskNames): TaskWords | null {
  const server = names.label || names.server;
  const guest = names.guest ?? named(args, 'guest', 'the guest');
  const on = `${guest} on ${server}`;
  const action = named(args, 'action', '');
  switch (tool) {
    case 'guest_migrate': {
      const target = named(args, 'target', 'the other node');
      return {
        what: `The move of ${guest} to ${target}`,
        doing: `Moving ${guest} from ${server} to ${target}`,
        ok: `${guest} is on ${target} now.`,
      };
    }
    case 'guest_config_set':
      return {
        what: `The settings change of ${on}`,
        doing: `Changing the settings of ${on}`,
        ok: `The new settings of ${on} are in place.`,
      };
    case 'guest_create': {
      const kind = args.kind === 'container' ? 'container' : 'VM';
      const name = names.name ?? named(args, 'name', 'the new guest');
      return {
        what: `The new ${kind} ${name} on ${server}`,
        doing: `Creating the ${kind} ${name} on ${server}`,
        ok: `The ${kind} ${name} on ${server} is ready${args.start === true ? ' and running' : ''}.`,
      };
    }
    case 'guest_clone': {
      const name = names.name ?? named(args, 'name', 'the copy');
      return {
        what: `The clone of ${on}`,
        doing: `Cloning ${on} as ${name}`,
        ok: `${name} is ready on ${server}, cloned from ${guest}.`,
      };
    }
    case 'guest_template':
      return {
        what: `Turning ${on} into a template`,
        doing: `Turning ${on} into a template`,
        ok: `${on} is a template now.`,
      };
    case 'guest_delete':
      return { what: `Deleting ${on}`, doing: `Deleting ${on}`, ok: `${guest} is deleted from ${server}.` };
    case 'guest_disk': {
      const disk = named(args, 'disk', 'the disk');
      if (action === 'move') {
        const to = named(args, 'storage', 'the other storage');
        return {
          what: `The move of the disk ${disk} of ${on}`,
          doing: `Moving the disk ${disk} of ${on} to ${to}`,
          ok: `The disk ${disk} of ${on} is on ${to} now.`,
        };
      }
      return {
        what: `Growing the disk ${disk} of ${on}`,
        doing: `Growing the disk ${disk} of ${on}`,
        ok: `The disk ${disk} of ${on} is bigger now.`,
      };
    }
    case 'guest_backup': {
      const backup = names.backup ?? 'the backup';
      // Incus and QEMU/KVM (IU-07): “web on the-titan is backed up.”; a restore there is always a new guest.
      if ((names.platform === 'incus' || names.platform === 'libvirt') && action === 'create')
        return { what: `The backup of ${on}`, doing: `Backing up ${on}`, ok: `${on} is backed up.` };
      if ((names.platform === 'incus' || names.platform === 'libvirt') && action === 'restore') {
        const name = names.name ?? `${guest}-restored`;
        return {
          what: `The restore of ${on}`,
          doing: `Restoring ${on} as ${name}`,
          ok: `${name} is ready on ${server}, restored from ${backup}.`,
        };
      }
      if (action === 'create') return { what: `The backup of ${on}`, doing: `Backing up ${on}` };
      if (action === 'restore')
        return args.as_new === true
          ? {
              what: `The restore of ${guest} as a new guest on ${server}`,
              doing: `Restoring a copy of ${guest} on ${server}`,
              ok: `The copy of ${guest} from ${backup} is ready on ${server}.`,
            }
          : {
              what: `The restore of ${on}`,
              doing: `Restoring ${on}`,
              ok: `${on} is back as it was in ${backup}.`,
            };
      if (action === 'delete')
        return {
          what: `Deleting ${backup} of ${on}`,
          doing: `Deleting ${backup} of ${on}`,
          ok: `${cap(backup)} of ${on} is deleted.`,
        };
      return null;
    }
    case 'backup_job_set': {
      if (action !== 'run') return null;
      const job = names.name ? `the backup job “${names.name}”` : 'the backup job';
      return {
        what: `${cap(job)} on ${server}`,
        doing: `Running ${job} on ${server}`,
        ok: `${cap(job)} on ${server} is done.`,
      };
    }
    case 'storage_content': {
      const storage = storageWords(named(args, 'storage', 'its storage'));
      const file = names.name || named(args, 'filename', 'the file');
      if (action === 'delete')
        return {
          what: `Deleting ${file} from ${storage} on ${server}`,
          doing: `Deleting ${file} from ${storage} on ${server}`,
          ok: `${file} is deleted from ${storage} on ${server}.`,
        };
      return {
        what: `The download of ${file} to ${storage} on ${server}`,
        doing: `Downloading ${file} to ${storage} on ${server}`,
        ok: `${file} is on ${storage} on ${server} now.`,
      };
    }
    case 'guest_rename': {
      const name = names.name ?? named(args, 'name', 'its new name');
      return {
        what: `Renaming ${on}`,
        doing: `Renaming ${on} to ${name}`,
        ok: `${on} is called ${name} now.`,
      };
    }
    case 'guest_move': {
      const where = moveWhere(args);
      return {
        what: `The move of ${on}`,
        doing: `Moving ${on} to ${where}`,
        ok: `${on} is on ${where} now.`,
      };
    }
    case 'guest_publish': {
      const alias = named(args, 'alias', '');
      return {
        what: `The image of ${on}`,
        doing: `Making an image of ${on}`,
        ok: `The image of ${on} is ready${alias ? ` as ${alias}` : ''}.`,
      };
    }
    case 'incus_image': {
      if (action === 'download') {
        const alias = named(args, 'alias', 'the image');
        return {
          what: `The download of the image ${alias} to ${server}`,
          doing: `Downloading the image ${alias} to ${server}`,
          ok: `The image ${alias} is on ${server} now.`,
        };
      }
      if (action === 'refresh')
        return {
          what: `Refreshing an image on ${server}`,
          doing: `Refreshing an image on ${server}`,
          ok: `The image on ${server} is up to date.`,
        };
      return {
        what: `Deleting an image on ${server}`,
        doing: `Deleting an image on ${server}`,
        ok: `The image is deleted from ${server}.`,
      };
    }
    case 'unraid_array':
      switch (action) {
        case 'start':
          return {
            what: `Starting the array of ${server}`,
            doing: `Starting the array of ${server}`,
            ok: `The array of ${server} is started.`,
          };
        case 'stop':
          return {
            what: `Stopping the array of ${server}`,
            doing: `Stopping the array of ${server}`,
            ok: `The array of ${server} is stopped.`,
          };
        case 'parity_check':
          return {
            what: `The parity check${args.correct === true ? ' with corrections' : ''} on ${server}`,
            doing: `Checking parity on ${server}`,
            after: 'parity',
          };
        case 'mover':
          return {
            what: `The mover on ${server}`,
            doing: `Moving files on ${server}`,
            ok: `The mover on ${server} is done.`,
          };
        default:
          // Pausing, resuming, cancelling and spinning take seconds: the words after a yes already said “now”.
          return null;
      }
    case 'unraid_plugins': {
      if (action === 'check')
        return {
          what: `The plugin check on ${server}`,
          doing: `Checking the plugins on ${server}`,
          after: 'plugins',
        };
      const plugin = pluginName(args);
      return plugin
        ? {
            what: `The update of the plugin ${plugin} on ${server}`,
            doing: `Updating the plugin ${plugin} on ${server}`,
            ok: `The plugin ${plugin} on ${server} is up to date now.`,
          }
        : {
            what: `The plugin updates on ${server}`,
            doing: `Updating the plugins on ${server}`,
            ok: `The plugins on ${server} are up to date now.`,
          };
    }
    case 'container_update':
      return action === 'check'
        ? {
            what: `The container update check on ${server}`,
            doing: `Checking the containers on ${server} for updates`,
            after: 'containers',
          }
        : { what: `The update of ${on}`, doing: `Updating ${on}`, ok: `${on} is up to date now.` };
    case 'app_update': {
      // The line at the end is written from each app's outcome (`appsOutcomeText`).
      const list = appListWords(appNames(args));
      return {
        server,
        what: `The update of ${list} on ${server}`,
        doing: `Updating ${list} on ${server}`,
        after: 'apps',
      };
    }
    case 'server_update': {
      const op = action === 'check' ? 'packages.check' : 'packages.install';
      const codes = {
        busy: packageTaskCodeText(op, 'busy', server) as string,
        timeout: packageTaskCodeText(op, 'timeout', server) as string,
      };
      if (op === 'packages.check')
        return {
          server,
          what: `The check for updates on ${server}`,
          doing: `Checking ${server} for updates`,
          after: 'updates.check',
          codes,
        };
      const packages = Array.isArray(args.packages)
        ? args.packages.filter((p): p is string => typeof p === 'string' && p !== '')
        : [];
      // The card says how many when Whombat read them, or which (“Installing 23 updates on shale”, TF-10).
      const waiting = waitingUpdates(names.server);
      return {
        server,
        what: `Installing updates on ${server}`,
        doing:
          packages.length || waiting
            ? updatePhrase(args, server, waiting).doing
            : `Installing updates on ${server}`,
        ok: `The updates on ${server} are installed.`,
        after: 'updates.install',
        codes,
        ...(packages.length ? { packages } : {}),
      };
    }
    default:
      return null;
  }
}

/** Known Proxmox and Incus failures in plain words; anything else keeps the platform's first line. */
const REASONS: [RegExp, string][] = [
  [
    /interrupted by signal|aborted|stopped by user|received interrupt|\bcancel+ed\b/i,
    'it was stopped before it finished',
  ],
  [/array (is )?(not started|stopped)/i, 'the array isn’t started'],
  [/(instance|guest) is running|must be stopped|needs to be stopped/i, 'it has to be stopped first'],
  [/no space left|not enough (free )?space|out of space|quota exceeded/i, 'the storage is full'],
  [/already exists/i, 'something with that name is already there'],
  [/can'?t lock|is locked|lock (file|timeout)|locked by/i, 'something else was still working on the machine'],
  [/timed? ?out|got timeout/i, 'it took too long and was given up'],
  [/permission|not allowed|unauthori[sz]ed|\b403\b/i, 'the server didn’t allow it'],
  [
    /connection refused|unreachable|no route to host|could not resolve|name or service not known/i,
    'it couldn’t reach where it needed to',
  ],
];

/** The service's reason for a failed task, short and without ids, or null. */
export function taskReason(message: string | null | undefined): string | null {
  if (!message) return null;
  const line = (message.split(/\r?\n/).find((l) => l.trim()) ?? '').trim();
  for (const [re, words] of REASONS) if (re.test(line)) return words;
  const clean = line
    .replace(/UPID:\S+/g, '')
    .replace(/^TASK ERROR:\s*/i, '')
    .replace(/^command '[^']*' failed:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.:;,]+$/, '');
  if (!clean) return null;
  return clean.length > 200 ? `${clean.slice(0, 199).trimEnd()}…` : clean;
}

/** What the server's report says after a clean end (IU-07), from its detail (pure); null when it can't tell yet. */
export function taskAfterText(
  after: 'parity' | 'plugins' | 'containers',
  detail: Pick<HostServerDetail, 'unraid' | 'workloads'>,
  since: number,
  message?: string | null,
): string | null {
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many.replace('{n}', String(n)));
  if (after === 'parity') {
    const said = /(\d+)\s+(?:sync\s+)?errors?/i.exec(message ?? '');
    const last = detail.unraid?.array.parity.last;
    // The report comes every 30 s: a last check older than the task isn't this one.
    const errors = said
      ? Number(said[1])
      : last && Date.parse(last.at) >= since - 5 * 60_000
        ? last.errors
        : null;
    if (errors === null) return null;
    return errors === 0 ? 'No errors.' : plural(errors, 'It found 1 error.', 'It found {n} errors.');
  }
  if (after === 'plugins') {
    const plugins = detail.unraid?.plugins.filter((x) => x.update) ?? null;
    if (!plugins) return null;
    if (plugins.length === 0) return 'Every plugin is up to date.';
    return plugins.length === 1
      ? `${plugins[0]?.name} has an update.`
      : `${plugins.length} plugins have an update.`;
  }
  const containers = detail.workloads?.docker?.guests.filter((g) => g.updateAvailable) ?? null;
  if (!containers) return null;
  if (containers.length === 0) return 'Every container is up to date.';
  if (containers.length === 1) return `${containers[0]?.name} has an update.`;
  const names = containers.slice(0, 3).map((g) => g.name);
  const list =
    containers.length > 3
      ? `${names.join(', ')} and ${containers.length - 3} more`
      : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `${containers.length} apps have an update: ${list}.`;
}

/** The one message when a followed task ends: done, done with warnings, or what went wrong (with its code's words). */
export function taskOutcomeText(
  w: TaskWords,
  result: 'ok' | 'warning' | 'error',
  message: string | null | undefined,
  code?: string | null,
): string {
  const coded = code === 'busy' || code === 'timeout' ? w.codes?.[code] : undefined;
  if (coded) return coded;
  if (result === 'ok') return w.ok ?? `${w.what} is done.`;
  if (result === 'warning') {
    const n = Number(/WARNINGS?:\s*(\d+)/i.exec(message ?? '')?.[1] ?? 0);
    if (n === 1) return `${w.what} finished with 1 warning.`;
    return n > 1 ? `${w.what} finished with ${n} warnings.` : `${w.what} finished with warnings.`;
  }
  const why = taskReason(message);
  return why ? `${w.doing} didn’t work: ${why}.` : `${w.doing} didn’t work.`;
}
