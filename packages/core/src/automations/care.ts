/**
 * The automations a care plan turns on when the person says go ahead (Whombat docs/decisions/care-plan.md): a server's
 * system updates every Sunday at the start of the quiet hours for changes, restarting only inside them, a weekly
 * backup of QEMU/KVM machines, which libvirt can't schedule itself, and a server's Docker Compose apps' updates every
 * Sunday night (Whombat app-updates.md): the ones safe to update by themselves, the others asked as one question. Whombat writes them, never the assistant, so the plan
 * card's line and what runs are the same thing. Pure.
 */
import {
  AUTOMATION_DEFINITION_VERSION,
  type AutomationDefinition,
  AutomationDefinition as AutomationDefinitionSchema,
} from '../domain/automation.js';
import {
  backupTime,
  type CareAutomationKind,
  type ChangeWindow,
  cronAt,
  sundayNightDay,
} from '../domain/care-plan.js';

/** What a care automation is for: the server, the quiet hours and where its runs post. */
export interface CareAutomationInput {
  server: { id: string; name: string; self: boolean };
  window: ChangeWindow;
  timeZone: string;
  /** The person's Chat: where the runs say how they went. */
  conversationId: string;
  /** `vm_backup`: the QEMU/KVM guests it backs up (`libvirt:win11`). */
  guests?: readonly string[];
}

export interface CareAutomation {
  name: string;
  description: string;
  definition: AutomationDefinition;
}

/** Sunday, as cron counts. */
const SUNDAY = 0;

/** A run reads the time once more before a restart: past this it waits a week (the window's end). */
function updatesPrompt(input: CareAutomationInput): string {
  const { server, window, timeZone } = input;
  if (server.self)
    return [
      `The weekly system updates of the server ${server.id}, the one this Whombat runs on.`,
      'Read server_updates. When nothing waits, say so in one short sentence and stop.',
      'Otherwise call server_update with action install: on this server it asks the person first. Never restart this server yourself.',
      'Tell the person in one plain sentence what waits for their yes.',
    ].join(' ');
  return [
    `The weekly system updates of the server ${server.id}.`,
    'Read server_updates. When nothing waits, say so in one short sentence and stop.',
    'Otherwise call server_update with action install and wait until it ends.',
    `When server_updates then says it needs a restart and it is still before ${window.end} (${timeZone}), restart it with server_power reboot and check it comes back; later than that, leave the restart for next week.`,
    'Tell the person in one plain sentence what you did, with no package names or versions.',
  ].join(' ');
}

function vmBackupPrompt(input: CareAutomationInput): string {
  const guests = input.guests ?? [];
  return [
    `The weekly backup of the virtual machines on the server ${input.server.id}: ${guests.join(', ')}.`,
    'Back each one up with guest_backup action create, one at a time, and check guest_backups lists the new backup.',
    'Tell the person in one plain sentence how it went, naming any machine that failed.',
  ].join(' ');
}

/**
 * The apps' updates: a database's or a new major version's never run unattended. They become one question the person
 * answers in the morning (Yes, tonight · No); `hold_major` keeps an app whose new version turns out to be a major one.
 */
function appsPrompt(input: CareAutomationInput): string {
  const { server } = input;
  return [
    `The weekly app updates of the server ${server.id}.`,
    `Read app_updates for ${server.id}. When no app has an update, say so in one short sentence and stop.`,
    'Update the apps that don’t ask first with one app_update call with hold_major true, and wait until it ends (server_tasks).',
    'Then, if any app asks first (asksFirst: a database or a new major version), call app_update once more for just those, with ask true and the reasons app_updates gave: the person gets one question for them.',
    'When app_updates says the server needs a newer helper, say it gets it by itself and stop.',
    'Tell the person in one or two plain sentences what you updated, what went back, and what waits for their yes, with no image names.',
  ].join(' ');
}

/** A care step's automation, as Whombat turns it on. */
export function careAutomation(kind: CareAutomationKind, input: CareAutomationInput): CareAutomation {
  if (kind === 'apps') return appsAutomation(input);
  const { server, window, timeZone } = input;
  const updates = kind === 'updates';
  const time = updates ? window.start : backupTime(window);
  const definition = AutomationDefinitionSchema.parse({
    version: AUTOMATION_DEFINITION_VERSION,
    conversationId: input.conversationId,
    triggers: [
      {
        kind: 'schedule',
        schedule: { kind: 'cron', expr: cronAt(time, SUNDAY) },
        timeZone,
        // A Sunday the box was off isn't caught up in the day: changes wait for the next quiet hours.
        missed: 'skip',
        overlap: 'skip',
      },
    ],
    steps: [
      {
        id: updates ? 'install' : 'backup',
        kind: 'dispatch_agent',
        name: updates ? 'Install updates' : 'Back up the machines',
        prompt: updates ? updatesPrompt(input) : vmBackupPrompt(input),
        timeoutMinutes: 180,
      },
    ],
    limits: { runTimeoutMinutes: 240, maxConcurrentRuns: 1, maxRunsPerDay: 2 },
  });
  const name = (updates ? `Updates on ${server.name}` : `Backups of ${server.name}’s machines`).slice(0, 80);
  const description = updates
    ? server.self
      ? `Asks every Sunday at ${window.start} before installing ${server.name}’s system updates.`
      : `Installs ${server.name}’s system updates every Sunday at ${window.start} and restarts it before ${window.end} when it needs one.`
    : `Backs up the virtual machines on ${server.name} every Sunday at ${time}.`;
  return { name, description, definition };
}

/** The apps' updates, every Sunday night at the start of the quiet hours. */
function appsAutomation(input: CareAutomationInput): CareAutomation {
  const { server, window, timeZone } = input;
  const definition = AutomationDefinitionSchema.parse({
    version: AUTOMATION_DEFINITION_VERSION,
    conversationId: input.conversationId,
    triggers: [
      {
        kind: 'schedule',
        schedule: { kind: 'cron', expr: cronAt(window.start, sundayNightDay(window)) },
        timeZone,
        missed: 'skip',
        overlap: 'skip',
      },
    ],
    steps: [
      {
        id: 'apps',
        kind: 'dispatch_agent',
        name: 'Update apps',
        prompt: appsPrompt(input),
        timeoutMinutes: 180,
      },
    ],
    limits: { runTimeoutMinutes: 240, maxConcurrentRuns: 1, maxRunsPerDay: 2 },
  });
  return {
    name: `Apps on ${server.name}`.slice(0, 80),
    description: `Updates ${server.name}’s apps every Sunday night at ${window.start} and asks you first about databases and new major versions.`,
    definition,
  };
}
