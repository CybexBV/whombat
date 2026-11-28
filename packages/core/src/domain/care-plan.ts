/**
 * Looking after a server from the day it is added (Whombat docs/decisions/care-plan.md): one plan of sensible defaults
 * the person says yes to once — backups, snapshots, system updates in the quiet hours for changes — instead of a dialog
 * per server and per machine. The defaults are the dialogs' own. And the one change window every schedule uses: the
 * “Quiet hours for changes” of a Whombat, 03:00–05:00 in its time zone unless the person moved them. Pure.
 */

import { z } from 'zod';
import { type CoreTranslator, coreTranslator, coreWords } from '../i18n/catalog.js';
import { plural } from '../text/format.js';
import type { HostGuest, HostServerPlatform } from './hosts.js';
import { LOOK_FIX_STEP_MAX, LOOK_PLAN_STEP_MAX, LOOK_PLAN_STEPS_MAX } from './look-research.js';
import { ClockTime } from './notify.js';

/* The quiet hours for changes ------------------------------------------------------------------------------------- */

/**
 * When changes that can wait happen (installing updates, restarts, an approval's *Tonight*): from `start` to `end` in
 * the Whombat's time zone; an `end` before `start` runs past midnight (23:00–01:00).
 */
export const ChangeWindow = z.object({ start: ClockTime, end: ClockTime }).refine((w) => w.start !== w.end, {
  message: 'The quiet hours start and end at different times.',
  path: ['end'],
});
export type ChangeWindow = z.infer<typeof ChangeWindow>;

/** A Whombat's quiet hours until the person moves them. */
export const CHANGE_WINDOW_DEFAULT: ChangeWindow = { start: '03:00', end: '05:00' };

const CHANGE_WINDOW_WORDS_KEYS = ['title', 'about', 'from', 'to', 'saved', 'failed'] as const;

/** The setting's words: its name and what it is for. */
export function changeWindowWords(
  locale?: string | null,
): Readonly<Record<(typeof CHANGE_WINDOW_WORDS_KEYS)[number], string>> {
  return coreWords(locale, 'changeWindow', CHANGE_WINDOW_WORDS_KEYS);
}

export const CHANGE_WINDOW_WORDS = changeWindowWords('en');

/** Minutes since midnight of an `HH:MM`. */
export function clockMinutes(time: string): number {
  const [h, m] = time.split(':');
  return Number(h) * 60 + Number(m);
}

/** `HH:MM` of minutes since midnight, wrapped into one day. */
export function minutesClock(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** “03:00–05:00”. */
export function changeWindowText(w: ChangeWindow): string {
  return `${w.start}–${w.end}`;
}

/** Whether a wall-clock time is inside the window (the start counts, the end doesn't). */
export function inChangeWindow(time: string, w: ChangeWindow): boolean {
  const t = clockMinutes(time);
  const s = clockMinutes(w.start);
  const e = clockMinutes(w.end);
  return s < e ? t >= s && t < e : t >= s || t < e;
}

/** How long the window is, in minutes. */
export function changeWindowMinutes(w: ChangeWindow): number {
  return (clockMinutes(w.end) - clockMinutes(w.start) + 1440) % 1440;
}

/**
 * When backups run: an hour before the quiet hours start (02:00 by default, the backup dialogs' own default), so a fresh
 * backup exists before anything changes.
 */
export function backupTime(w: ChangeWindow): string {
  return minutesClock(clockMinutes(w.start) - 60);
}

/**
 * The weekday (cron's, 0 Sunday … 6 Saturday) on which the quiet hours of Sunday night start: Sunday when they start in
 * the evening (23:00), Monday when they start after midnight (03:00, the night from Sunday to Monday).
 */
export function sundayNightDay(w: ChangeWindow): number {
  return clockMinutes(w.start) >= 12 * 60 ? 0 : 1;
}

/** A five-field cron line at a wall-clock time: every day, or on one weekday (0 Sunday … 6 Saturday). */
export function cronAt(time: string, weekday?: number): string {
  const [h, m] = time.split(':');
  return `${Number(m)} ${Number(h)} * * ${weekday === undefined ? '*' : weekday}`;
}

/* Temporary machines ---------------------------------------------------------------------------------------------- */

/** The label Whombat puts on the containers it runs itself (its services, `docker run --label whombat.service=1`). */
const WHOMBAT_SERVICE_LABEL = 'whombat.service';
/** A CI system's job machine (`ci-job-a8791974…`): made for one build and removed after it. */
const CI_JOB = /^ci-job-/;
/** A sandbox the agent-resource helper leases (`agent-<lease id>-<8 hex>`, its Compose project `agent-<lease id>-compose`). */
const LEASED = /^agent-[0-9a-f]{32}-/;

/** The project of an Incus guest id (`incus:web` is `default`, `incus:ci/job-1` is `ci`). */
function incusProject(guestId: string): string {
  const rest = guestId.replace(/^incus:/, '');
  const at = rest.indexOf('/');
  return at < 0 ? 'default' : rest.slice(0, at);
}

export type TemporaryFacts = Pick<HostGuest, 'id' | 'name' | 'platform'> &
  Partial<Pick<HostGuest, 'project' | 'labels' | 'self'>>;

/**
 * Whether a guest is a temporary machine (Whombat server-pages.md): an Incus instance outside the `default` project (CI
 * and sandbox projects keep their throwaway machines apart; their id is `project/name`), a CI job's machine, a leased
 * sandbox, or a container Whombat runs itself. The machine this Whombat runs in never is. Pages hide them; a care plan
 * never includes them.
 */
export function isTemporaryGuest(g: TemporaryFacts): boolean {
  if (g.self) return false;
  if (g.platform === 'incus' && (g.project ?? incusProject(g.id)) !== 'default') return true;
  if (CI_JOB.test(g.name) || LEASED.test(g.name)) return true;
  if (g.platform === 'docker' && g.project && LEASED.test(g.project)) return true;
  return g.labels?.[WHOMBAT_SERVICE_LABEL] === '1';
}

/** Whether a server is a temporary machine of its own (a CI job's or a leased sandbox with Whombat's helper on it). */
export function isTemporaryServer(name: string): boolean {
  return CI_JOB.test(name) || LEASED.test(name);
}

/* The care plan --------------------------------------------------------------------------------------------------- */

/**
 * The kinds of step a care plan has: `backup` a Proxmox backup plan for every machine, `snapshots` an Incus snapshot
 * schedule per machine, `vm_backup` a weekly backup of QEMU/KVM machines (an automation: libvirt has no schedule of
 * its own), `updates` the system updates every week in the quiet hours (an automation), `apps` the Docker Compose apps'
 * updates every Sunday night in the quiet hours (an automation; where no app was started with Compose, telling the
 * person about app updates, which Whombat's helper does already).
 */
export const CARE_STEP_IDS = ['backup', 'snapshots', 'vm_backup', 'updates', 'apps'] as const;
export const CareStepId = z.enum(CARE_STEP_IDS);
export type CareStepId = z.infer<typeof CareStepId>;

/** The care steps Whombat turns on itself, as an automation, when the person says go ahead. */
export type CareAutomationKind = 'updates' | 'vm_backup' | 'apps';

/**
 * One step as the plan offers it: `text` the card's line with the defaults chosen, `step` what the assistant does when
 * the person says go ahead (never shown), `automation` the automation Whombat turns on instead (the step then has
 * nothing left for the assistant to do).
 */
export interface CareStep {
  id: CareStepId;
  text: string;
  step: string;
  automation?: CareAutomationKind;
  /** The machines it covers (`vm_backup`: the guests the automation backs up). */
  guests?: string[];
}

/** A guest as the plan weighs it. */
export type CareGuest = TemporaryFacts & Partial<Pick<HostGuest, 'kind' | 'app'>>;

/** What Whombat knows about a server when it plans its care. */
export interface CareFacts {
  server: {
    /** The hosts service's id (what the Servers tools take). */
    id: string;
    name: string;
    platform: HostServerPlatform;
    /** This Whombat runs on it: its own changes keep asking. */
    self: boolean;
    /** Its IPv4 addresses on the home network (a folder shared over NFS is shared with these). */
    addresses?: readonly string[];
  };
  guests: readonly CareGuest[];
  /** A Proxmox server's storages that take backups (`content` lists `backup`), in the server's order. */
  backupStorages: readonly { id: string; type: string }[];
  /** What is in place already: those steps aren't offered again. */
  has?: Partial<Record<CareStepId, boolean>>;
  /**
   * A backup place that can share a folder over NFS (Whombat backup-places.md BPL-12): a Proxmox server without a Backup
   * Server or a storage on the network keeps its backups there, added as backup storage, rather than on its own disks.
   * `serverId`: the hosts service's id of the server that shares it (Unraid through Whombat's helper).
   */
  nasShare?: { serverId: string; name: string } | null;
}

/** The hint checks a care plan answers (`host.hint.<kind>`): missing backups and snapshots, waiting updates. */
export const CARE_CHECKS: ReadonlySet<string> = new Set([
  'host.hint.guest.no_backup_job',
  'host.hint.incus.no_snapshots',
  'host.hint.libvirt.no_backup',
  'host.hint.system.updates',
  'host.hint.docker.image_updates',
]);

/** Whether a Worth a look line is one a care plan answers. */
export function isCareCheck(check: string | null | undefined): boolean {
  return !!check && CARE_CHECKS.has(check);
}

/** The key of a server's care plan research, beside its looks' (`server:pve-01` → `care:server:pve-01`). */
export function careKey(thingKey: string): string {
  return `care:${thingKey}`.slice(0, 120);
}

/** The thing a care key is about (`care:server:pve-01` → `server:pve-01`); null for any other key. */
export function careThingKey(key: string): string | null {
  return key.startsWith('care:') ? key.slice(5) : null;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** “the 6 machines”, “web”: what a step covers, by name when there is one. */
function machines(tr: CoreTranslator, names: readonly string[], all = false): string {
  if (names.length === 1) return names[0] as string;
  return tr.tp(all ? 'carePlan.machines.all' : 'carePlan.machines.the', names.length, { n: names.length });
}

/** A guest's name for the person: its name, never its number. */
const nameOf = (g: CareGuest) => g.name || g.id;

/** Proxmox storage types that keep backups somewhere other than the server's own disks. */
const NETWORK_STORAGES: ReadonlySet<string> = new Set(['pbs', 'nfs', 'cifs', 'cephfs', 'glusterfs']);

/**
 * The storage a Proxmox backup plan saves to: a Proxmox Backup Server when there is one, else a storage on the network,
 * else the first storage that takes backups (the New job dialog's default).
 */
export function backupStorageOf(storages: CareFacts['backupStorages']): string | null {
  return (
    (
      storages.find((s) => s.type === 'pbs') ??
      storages.find((s) => NETWORK_STORAGES.has(s.type)) ??
      storages[0]
    )?.id ?? null
  );
}

/** A name as Proxmox and Unraid take it: lowercase letters, digits and dashes. */
const plainId = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');

/** The Proxmox storage a backup place's shared folder becomes (`blackbox-backup`). */
export function nasStorageName(placeName: string): string {
  return `${plainId(placeName) || 'nas'}-backup`;
}

/** The folder a backup place shares with one server (`whombat-pve-01`). */
export function nasShareName(serverId: string): string {
  return `whombat-${plainId(serverId) || 'server'}`;
}

/**
 * The care plan of a server (care-plan.md), at most six steps, with the defaults the dialogs use:
 *
 * - Proxmox: every machine in a nightly backup plan an hour before the quiet hours, to the Backup Server or a storage
 *   on the network, else to a backup place that shares a folder over NFS (added as backup storage first), else the
 *   first backup storage, keeping the newest 7 (a week);
 * - Incus: a daily snapshot of every long-lived machine (the `default` project's), kept 7 days;
 * - QEMU/KVM machines: a weekly backup on Sundays (an automation);
 * - every Linux server but Unraid: system updates on Sundays at the start of the quiet hours, restarting only inside
 *   them (an automation); the server this Whombat runs on asks first, as it always does; a Mac and a Windows PC none;
 * - Docker Compose apps: their updates every Sunday night at the start of the quiet hours (an automation): only the
 *   apps that are safe to update by themselves, the others asked as one question; containers `docker run` started:
 *   the person hears when they have updates.
 *
 * Temporary machines are never in it; steps already in place (`has`) are left out. Each step's line is in `locale`
 * (English when none); what the assistant does stays English.
 */
export function careSteps(facts: CareFacts, window: ChangeWindow, locale?: string | null): CareStep[] {
  const tr = coreTranslator(locale);
  const { server } = facts;
  const has = facts.has ?? {};
  const kept = facts.guests.filter((g) => !isTemporaryGuest(g));
  const temporary = facts.guests.length - kept.length;
  const at = backupTime(window);
  const out: CareStep[] = [];

  const pve = kept.filter((g) => g.platform === 'pve');
  // Backups on the disks the machines are on don't survive those disks: a backup place on the network first.
  const offServer = facts.backupStorages.some((s) => NETWORK_STORAGES.has(s.type));
  const nas =
    server.platform === 'proxmox' && !offServer && facts.nasShare && server.addresses?.length
      ? facts.nasShare
      : null;
  const storage = nas ? nasStorageName(nas.name) : backupStorageOf(facts.backupStorages);
  if (server.platform === 'proxmox' && pve.length && storage && !has.backup) {
    const names = pve.map(nameOf);
    // Every guest the job selects, or (with temporary ones on it) exactly the person's own.
    const which = temporary
      ? `selection guests: create it with the first of ${pve.map((g) => g.id).join(', ')} and add_guest the others`
      : 'selection all';
    // Mode snapshot is the tool's default (the guests keep running).
    const job = `backup_job_set create on ${server.id}: schedule "${at}", storage "${storage}", keep {"last": 7}, ${which}`;
    out.push({
      id: 'backup',
      text: tr.t('carePlan.step.backup', {
        machines: machines(tr, names, true),
        at,
        place: nas ? nas.name : storage,
      }),
      step: nas
        ? `backup_place_nfs on ${nas.serverId}, name "${nasShareName(server.id)}", clients ${JSON.stringify(server.addresses)}; proxmox_storage_add on ${server.id}, storage "${storage}" with its nfs_server and export; then ${job}.`
        : `${job}. Check backup_jobs lists it.`,
    });
  }

  const incus = kept.filter((g) => g.platform === 'incus');
  if (incus.length && !has.snapshots) {
    out.push({
      id: 'snapshots',
      text: tr.t('carePlan.step.snapshots', { machines: machines(tr, incus.map(nameOf)), at }),
      step: `For each of ${incus.map((g) => g.id).join(', ')} on ${server.id}: guest_config (for its digest), then guest_config_set with set {"snapshots.schedule": "${cronAt(at)}", "snapshots.expiry": "7d"}.`,
    });
  }

  const vms = kept.filter((g) => g.platform === 'libvirt');
  if (vms.length && !has.vm_backup) {
    out.push({
      id: 'vm_backup',
      text: tr.t('carePlan.step.vmBackup', { machines: machines(tr, vms.map(nameOf)), at }),
      step: 'Whombat turns this on as an automation when the person says go ahead: nothing for you to do.',
      automation: 'vm_backup',
      guests: vms.map((g) => g.id),
    });
  }

  // Unraid updates itself its own way; a Mac's updates restart the person's own computer (macos-servers.md); Whombat
  // doesn't install a Windows PC's updates (windows-servers.md).
  const ownUpdates =
    server.platform === 'unraid' || server.platform === 'macos' || server.platform === 'windows';
  if (!ownUpdates && !has.updates) {
    out.push({
      id: 'updates',
      text: tr.t(server.self ? 'carePlan.step.updatesAsk' : 'carePlan.step.updates', { time: window.start }),
      step: 'Whombat turns this on as an automation when the person says go ahead: nothing for you to do.',
      automation: 'updates',
    });
  }

  const docker = kept.filter((g) => g.platform === 'docker');
  // Compose apps (or a helper that will report them once it has updated itself) can be updated by Whombat.
  const compose = docker.some((g) => g.app || g.project);
  if (compose && !has.apps) {
    out.push({
      id: 'apps',
      text: tr.t('carePlan.step.apps', { time: window.start }),
      step: 'Whombat turns this on as an automation when the person says go ahead: nothing for you to do.',
      automation: 'apps',
    });
  } else if (docker.length && !has.apps) {
    out.push({
      id: 'apps',
      text: tr.t('carePlan.step.appsTell'),
      step: 'Nothing to set up: Whombat’s helper checks the apps for updates and they show on the server’s page.',
    });
  }

  return out.slice(0, LOOK_PLAN_STEPS_MAX).map((s) => ({
    ...s,
    text: clip(s.text, LOOK_PLAN_STEP_MAX),
    step: clip(s.step, LOOK_FIX_STEP_MAX),
  }));
}

const CARE_PLAN_WORDS_KEYS = [
  /** The assistant's first line in the server's thread, as it works out the plan. */
  'opening',
  'head',
  'headDone',
  /** The push for a care plan waiting for the person's yes. */
  'push',
] as const;

/** The plan card's words for a care plan: how the assistant will look after the server, then how it does. */
export function carePlanWords(
  locale?: string | null,
): Readonly<Record<(typeof CARE_PLAN_WORDS_KEYS)[number], string>> {
  return coreWords(locale, 'carePlan', CARE_PLAN_WORDS_KEYS);
}

export const CARE_PLAN_WORDS = carePlanWords('en');

/** The care plan's push: “Here’s how I’d look after pve-01: 3 steps, ready for your OK.” */
export function carePushText(name: string, steps: number): string {
  return CARE_PLAN_WORDS.push.replace('{name}', name).replace('{steps}', plural(steps, 'step'));
}

/** The assistant's first line in a new server's thread. */
export function careOpeningText(name: string): string {
  return CARE_PLAN_WORDS.opening.replace('{name}', name);
}
