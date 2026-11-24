/**
 * Whombat's own tools in the one-Whombat shell (Whombat one-whombat.md ONE-06, ONE-09, ONE-16…ONE-19; contracts 0.80.0,
 * CT-337, CT-340, CT-343). Spread into `MCP_TOOLS`; only in a turn for a person (OA-10).
 *
 * - `set_chat_title`: once per task chat, a better title than its first line.
 * - `pin_widget`: a panel on the person's Overview page that the server refreshes without the AI (a read-only tool call, or a
 *   server metric).
 * - `device_probe`: read a device on the network with the built-in drivers, read-only (it refuses writes).
 * - `propose_device_skill`: the device's profile, tested, as a `device_skill` card for the owner to switch on.
 * - `watch_checks`: what Whombat watches on a connection, server or device, and switching a check off or on when the
 *   person said so (Whombat docs/decisions/on-purpose.md).
 * - `watch_status` and `watch_history`: what needs the person now, and what went wrong over a period (Whombat
 *   docs/decisions/monitoring.md MON-10), read-only.
 * - `quiet_until`: keep a connection, server or device quiet until a time, or end that, when the person said so
 *   (Whombat docs/decisions/monitoring.md MON-04).
 */
import { z } from 'zod';
import { DeviceDriver, DeviceProfile, DeviceReading } from '../domain/devices.js';
import { WIDGET_REFRESH_MAX_S, WIDGET_REFRESH_MIN_S, WidgetSource } from '../domain/home.js';
import {
  KEEP_QUIET_MAX_MINUTES,
  KEEP_QUIET_MIN_MINUTES,
  NoticeCheck,
  NoticeNature,
  NoticeSubjectId,
  ThingWatchLimit,
  WatchLimitValue,
} from '../domain/quiet.js';
import { ThingWatchEvent, ThingWatchMinutes, ThingWatchView } from '../domain/thing-watch.js';
import { DeviceSkillProposalId, ThingWatchId, WidgetId } from '../ids.js';
import { commitOutcome } from './errors.js';
import type { McpTool } from './mcp.js';

function oneTool<I extends z.ZodObject, O extends z.ZodType>(def: McpTool<I, O>): McpTool<I, O> {
  return def;
}

/** A thing's incident as the assistant reads it: what, when, how long, and its cause. */
export const AgentIncident = z.object({
  thing: z.string(),
  name: z.string(),
  /** `down` (doesn't answer) or `problem` (answers, but something is wrong). */
  nature: z.enum(['down', 'problem']),
  words: z.string(),
  started: z.string(),
  /** Absent while it lasts. */
  ended: z.string().optional(),
  minutes: z.number().int(),
  /** Down because this one, what it runs on, was down. */
  causedBy: z.string().optional(),
});
export type AgentIncident = z.infer<typeof AgentIncident>;

/** A device's address on the local network: an IPv4/IPv6 address or a host name (no scheme, no path). */
const DeviceHost = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9.:_-]+$/, 'Give the device’s address or host name, without http:// or a path.');
const Port = z.number().int().min(1).max(65_535);
const UnitId = z.number().int().min(0).max(255);

/** One reading's answer from `device_probe`: the scaled value, the raw words or text, or why it failed. */
export const DeviceProbeValue = z.object({
  key: z.string(),
  label: z.string(),
  value: z.union([z.number(), z.boolean(), z.string()]).nullable(),
  unit: z.string().optional(),
  raw: z.string().max(200).optional(),
  error: z.string().max(200).optional(),
});
export type DeviceProbeValue = z.infer<typeof DeviceProbeValue>;

/** The most readings one probe reads. */
export const DEVICE_PROBE_READINGS_MAX = 64;

/**
 * One check as `watch_checks` answers it: its id and plain name, whether Whombat watches it, and the items it doesn't
 * (`not`: their names, “Garage AP”), or that it is ignored or snoozed for now.
 */
export const AgentWatchCheck = z.object({
  check: NoticeCheck,
  name: z.string(),
  nature: NoticeNature,
  on: z.boolean(),
  /** Items (or the whole thing) left out, ignored or snoozed, in plain words: “Garage AP: not watched”. */
  except: z.array(z.string()).optional(),
  limit: ThingWatchLimit.optional(),
});
export type AgentWatchCheck = z.infer<typeof AgentWatchCheck>;

export const ONE_MCP_TOOLS = {
  set_chat_title: oneTool({
    name: 'set_chat_title',
    title: 'Name this chat',
    description:
      'Give this chat a short, plain title (at most 60 characters) once you know what it is about: “Heat pump temperatures”, “pve-02 updates”. Only once per chat; never in the default chat.',
    input: z.object({ title: z.string().trim().min(1).max(60) }),
    output: commitOutcome({}),
    requiredKey: null,
    readOnly: false,
    personal: true,
  }),
  pin_widget: oneTool({
    name: 'pin_widget',
    title: 'Pin a widget to Overview or a page',
    description:
      'Pin a chart that keeps itself up to date without you to the person’s Overview page, or with `thingId` to that connection’s, device’s or server’s page: either a read-only connection tool with fixed arguments and the numbers to plot (JSON pointers into its answer, up to 3), or a server’s metrics. Offer it when someone wants to keep an eye on something; when they ask from a thing’s page to keep something there, pass its `thingId`. Test the tool call first so the pointers are right.',
    input: z.object({
      title: z.string().trim().min(1).max(80),
      subtitle: z.string().trim().max(120).optional(),
      source: WidgetSource,
      refreshSec: z.number().int().min(WIDGET_REFRESH_MIN_S).max(WIDGET_REFRESH_MAX_S).optional(),
      /** Keep it on this thing's page instead of the Overview page (0.88, CT-392): `connection:con_…`, `device:…`, `server:<id>`. */
      thingId: z.string().trim().min(3).max(220).optional(),
    }),
    output: commitOutcome({ widgetId: WidgetId }),
    requiredKey: null,
    readOnly: false,
    personal: true,
  }),
  device_probe: oneTool({
    name: 'device_probe',
    title: 'Read a device',
    description:
      'Read values from a device on the local network with Whombat’s drivers (Modbus TCP, or a local HTTP/JSON API), read-only: it never writes. Use it to test the register map or the JSON paths from the device’s manual against the real unit before you propose a skill.',
    input: z.object({
      driver: DeviceDriver,
      host: DeviceHost,
      port: Port.optional(),
      unitId: UnitId.optional(),
      readings: z.array(DeviceReading).min(1).max(DEVICE_PROBE_READINGS_MAX),
    }),
    output: commitOutcome({ readings: z.array(DeviceProbeValue), at: z.iso.datetime({ offset: true }) }),
    requiredKey: null,
    readOnly: true,
    personal: true,
  }),
  propose_device_skill: oneTool({
    name: 'propose_device_skill',
    title: 'Propose a device skill',
    description:
      'Propose a skill for a device once device_probe read it: its profile (driver, readings, and actions with their types, ranges and choices, from the manual), where it is, and the manual it came from. The person sees a card with what you can read and change and chooses Off, Ask me or Allowed and limits for each action; nothing changes on the device until they switch it on.',
    input: z.object({
      profile: DeviceProfile,
      host: DeviceHost,
      port: Port.optional(),
      unitId: UnitId.optional(),
    }),
    output: commitOutcome({ proposalId: DeviceSkillProposalId }),
    requiredKey: null,
    readOnly: false,
    personal: true,
  }),
  watch_checks: oneTool({
    name: 'watch_checks',
    title: 'What Whombat watches',
    description:
      'See what Whombat watches on a connection, server or device, or switch one check off or on. thing: its page id (connection:con_…, server:<id>, device:<id>) or a connection’s handle. Without watched or limit it lists the checks. For a server check that shows a limit, use check and limit to set it in the returned unit, or null to clear it. Include subject and subjectName to change only that item. Change a limit only when the person asked you to in this conversation or pressed your proposed step for it. With check and watched: false Whombat stops watching it, for the whole thing or, with subject (an item’s id as Whombat gave it) and subjectName, for that item, until someone turns it on again; watched: true turns it back on. Switch one off only when the person told you to in this conversation (it is on purpose, they don’t want to hear about it) or pressed your step for it; when something only looks deliberate, ask them or offer it as your step. It shows in what you did, with Undo.',
    input: z.object({
      thing: z.string().trim().min(1).max(220),
      check: NoticeCheck.optional(),
      subject: NoticeSubjectId.optional(),
      /** The item's name as people know it (“Garage AP”), with `subject`. */
      subjectName: z.string().trim().min(1).max(80).optional(),
      watched: z.boolean().optional(),
      limit: WatchLimitValue.nullable().optional(),
    }),
    output: commitOutcome({ checks: z.array(AgentWatchCheck) }),
    requiredKey: null,
    readOnly: false,
    personal: true,
  }),
  watch_status: oneTool({
    name: 'watch_status',
    title: 'How everything is',
    description:
      'What needs the person now, in one call: what waits for them in the Inbox, the servers, connections and devices that aren’t fine and why, what is down or broken right now (with since when), and what is kept quiet for a while. Use it for “Is everything OK?” before looking at single things.',
    input: z.object({}),
    output: commitOutcome({
      inbox: z.string(),
      notFine: z.array(
        z.object({
          thing: z.string(),
          name: z.string(),
          state: z.enum(['down', 'bad', 'look']),
          reason: z.string().optional(),
          causedBy: z.string().optional(),
        }),
      ),
      incidents: z.array(AgentIncident),
      quiet: z.array(
        z.object({ thing: z.string(), name: z.string(), until: z.string(), note: z.string().optional() }),
      ),
    }),
    requiredKey: null,
    readOnly: true,
    personal: true,
  }),
  thing_watch: oneTool({
    name: 'thing_watch',
    title: 'Watch for something once',
    description:
      'When the person asks in this chat, start a one-time watch for a server, connection or device to go down or come back. Use action: start, thing (its page id, name or handle) and event: down or back. Use minutes for a deadline like tonight (24 hours by default, at most 7 days). Whombat posts a card and tells them once in this thread, immediately if it already happened. Use action: list to see running watches and action: cancel with watchId to stop one. Use an automation for every time.',
    input: z.object({
      action: z.enum(['start', 'list', 'cancel']),
      thing: z.string().trim().min(1).max(220).optional(),
      event: ThingWatchEvent.optional(),
      minutes: ThingWatchMinutes.optional(),
      watchId: ThingWatchId.optional(),
    }),
    output: commitOutcome({
      watches: z.array(ThingWatchView),
      note: z.string(),
    }),
    requiredKey: null,
    readOnly: false,
    personal: true,
  }),
  watch_history: oneTool({
    name: 'watch_history',
    title: 'What went wrong',
    description:
      'What went wrong over a period, for one thing or all: each time something was down or had a problem (when, how long, why), how much of the time it answered, and the alerts the servers had. thing: its page id (connection:con_…, server:<id>, device:<id>) or a connection’s handle; leave out for everything. days: how far back, 1 to 90 (7 when left out). Use it for “What broke while I was away?”.',
    input: z.object({
      thing: z.string().trim().min(1).max(220).optional(),
      days: z.number().int().min(1).max(90).optional(),
    }),
    output: commitOutcome({
      from: z.string(),
      days: z.number().int(),
      incidents: z.array(AgentIncident),
      uptime: z.array(z.object({ thing: z.string(), name: z.string(), text: z.string() })),
      serverAlerts: z.array(
        z.object({
          server: z.string(),
          title: z.string(),
          severity: z.enum(['critical', 'warning']),
          opened: z.string(),
          resolved: z.string().optional(),
        }),
      ),
      note: z.string().optional(),
    }),
    requiredKey: null,
    readOnly: true,
    personal: true,
  }),
  quiet_until: oneTool({
    name: 'quiet_until',
    title: 'Keep quiet for a while',
    description:
      'Keep a connection, server or device quiet until a time, or for some minutes, with an optional short note (“Moving the NAS”): until then its problems make no look, Inbox item or push, and a server’s alerts are muted too. When it ends, what is still wrong counts again. With end: true it ends now. thing: its page id (connection:con_…, server:<id>, device:<id>) or a connection’s handle. Without until, minutes or end it only says whether it is kept quiet. Do it only when the person told you to in this conversation (“keep the NAS quiet tonight”); it shows in what you did, with Undo.',
    input: z.object({
      thing: z.string().trim().min(1).max(220),
      /** When it ends, with its offset (“2026-11-24T23:00:00+01:00”). */
      until: z.iso.datetime({ offset: true }).optional(),
      minutes: z.number().int().min(KEEP_QUIET_MIN_MINUTES).max(KEEP_QUIET_MAX_MINUTES).optional(),
      note: z.string().trim().min(1).max(120).optional(),
      end: z.boolean().optional(),
    }),
    output: commitOutcome({
      /** How it is kept quiet now (“Quiet until 23:00 · Moving the NAS”); null when it isn't. */
      quiet: z.object({ words: z.string(), until: z.string() }).nullable(),
    }),
    requiredKey: null,
    readOnly: false,
    personal: true,
  }),
} as const;
