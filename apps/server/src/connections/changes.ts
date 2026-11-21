/**
 * Changes made through connection tools (docs/decisions/one-whombat.md ONE-08; one-whombat-assistant.md ONE-DW18…):
 * every write call that worked is recorded with a plain title for Done recently, and with the call that undoes it where
 * Whombat knows one.
 *
 * - **Before the call** (`prepareConnectionChange`): the title, the subject and, where it can, the inverse — Home
 *   Assistant's MCP `…HassTurnOn` ↔ `…HassTurnOff` (same arguments); a REST `turn_on` / `turn_off` / `toggle` or a
 *   climate `set_temperature` reads the entity's state first and undoes to it; Todoist's `tasks_update` reads the task
 *   first and undoes to its old fields. Reading the old state never fails the call: without it there is no Undo.
 * - **The title** (docs/decisions/home-redesign.md HR-02, `changeTitle`): Whombat's own words when they come with an
 *   Undo, else the agent's `change` (“Removed 14 old Zonneplan entities”), else Whombat's words without an Undo, else
 *   the generic title, which names the connection without its address (“Changed something in Home Assistant”).
 * - **After it worked** the change is recorded in `finish_connection_tool`'s commit, sealed (`recordChange`).
 * - **Undo** (`connection.call`, `undoConnectionChange`): the inverse is a new `call_connection_tool` by the Whombat that
 *   made the change, for the person who pressed Undo, so the keys, the tool's tier and approvals apply again. Its call id
 *   (`undo.<change>.<person>.<n>`) marks the original change undone once the inverse has run, now or after a yes.
 */
import { type CatalogEntry, newId, REQUEST_TOOL_NAME, SOCKET_TOOL_NAME, thingHref } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { connectionTools } from '../db/schema/index';
import type { Services } from '../services';
import { connectionCallAccess } from './call-access';
import { nameWithoutAddress } from './labels';
import { outputDocument } from './output';
import type { CallOutput } from './request';
import type { CatalogConnectionRow, ConnectionToolRow } from './types';

/** The undoer kind of a connection change. */
export const CONNECTION_UNDO_KIND = 'connection.call';

/** What undoes a connection change: one call of a tool of the same connection. */
export interface ConnectionUndo {
  connectionId: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface PreparedChange {
  title: string;
  detail?: string;
  undo: ConnectionUndo | null;
}

/** Reads a tool of the connection the same way the call would (a read: the old state). */
export type ReadTool = (tool: string, args: Record<string, unknown>) => Promise<CallOutput>;

/** “light.kitchen” → “Kitchen”; prefers the entity's friendly name. */
function entityLabel(entityId: string, friendly?: unknown): string {
  if (typeof friendly === 'string' && friendly.trim()) return friendly.trim().slice(0, 80);
  const name = entityId.includes('.') ? entityId.slice(entityId.indexOf('.') + 1) : entityId;
  const words = name.replace(/_/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : entityId;
}

/** A tool name in words: `tasks_update` → “tasks update”, `HassLightSet` → “hass light set”. */
function toolWords(tool: string): string {
  const base = tool.includes('__') ? tool.slice(tool.lastIndexOf('__') + 2) : tool;
  return base
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .trim();
}

/** The plain title of a write nobody has words for: “Used tasks update in Todoist”. `name`: without its address. */
export function genericChangeTitle(tool: string, name: string): string {
  if (tool === REQUEST_TOOL_NAME || tool === SOCKET_TOOL_NAME)
    return `Changed something in ${name}`.slice(0, 200);
  return `Used ${toolWords(tool)} in ${name}`.slice(0, 200);
}

/**
 * A write's change from what each side says (HR-02): Whombat's own words with their Undo first, then the agent's words
 * (`change`, one line), then Whombat's words without an Undo, then the generic title.
 */
export function changeTitle(
  known: PreparedChange | null,
  agentWords: string | null | undefined,
  generic: string,
): PreparedChange {
  if (known?.undo) return known;
  const said = agentWords?.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (said) return { title: said, undo: null };
  return known ?? { title: generic, undo: null };
}

/** What a Home Assistant MCP target is called in the arguments (“the hallway light”, “the kitchen”). */
function haTarget(args: Readonly<Record<string, unknown>>): string {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  const area = typeof args.area === 'string' ? args.area.trim() : '';
  const domain = Array.isArray(args.domain) ? String(args.domain[0] ?? '') : String(args.domain ?? '');
  if (name) return name;
  if (area && domain) return `the ${domain.replace(/_/g, ' ')}s in ${area}`;
  if (area) return `everything in ${area}`;
  return domain ? `the ${domain.replace(/_/g, ' ')}s` : 'it';
}

const HA_ON_OFF = /^(.*)Hass(TurnOn|TurnOff)$/;

/** A JSON body of a `request` call as an object (it may come as a string). */
function bodyObject(body: unknown): Record<string, unknown> | null {
  if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** An entity's state through the REST API (`GET /api/states/<id>`), or null. */
async function haState(
  read: ReadTool,
  entityId: string,
): Promise<{ state: string; attributes: Record<string, unknown> } | null> {
  if (!/^[a-z_]+\.[a-z0-9_]+$/.test(entityId)) return null;
  const out = await read(REQUEST_TOOL_NAME, { method: 'GET', path: `/api/states/${entityId}` });
  if (out.isError || (out.httpStatus !== undefined && out.httpStatus >= 300)) return null;
  const doc = outputDocument(out);
  const body =
    doc && typeof doc === 'object' && !Array.isArray(doc) ? (doc as Record<string, unknown>) : null;
  if (!body || typeof body.state !== 'string') return null;
  const attributes =
    body.attributes && typeof body.attributes === 'object'
      ? (body.attributes as Record<string, unknown>)
      : {};
  return { state: body.state, attributes };
}

async function homeAssistantChange(
  tool: ConnectionToolRow,
  args: Readonly<Record<string, unknown>>,
  label: string,
  connectionId: string,
  hasTool: (name: string) => Promise<boolean>,
  read: ReadTool,
): Promise<PreparedChange | null> {
  const mcp = HA_ON_OFF.exec(tool.name);
  if (mcp) {
    const on = mcp[2] === 'TurnOn';
    const inverse = `${mcp[1]}Hass${on ? 'TurnOff' : 'TurnOn'}`;
    return {
      title: `Turned ${on ? 'on' : 'off'} ${haTarget(args)}`.slice(0, 200),
      undo: (await hasTool(inverse)) ? { connectionId, tool: inverse, args: { ...args } } : null,
    };
  }
  if (tool.name !== REQUEST_TOOL_NAME || String(args.method).toUpperCase() !== 'POST') return null;
  const m = /^\/api\/services\/([a-z_]+)\/([a-z_]+)$/.exec(String(args.path ?? ''));
  if (!m) return null;
  const [, domain, service] = m as unknown as [string, string, string];
  const body = bodyObject(args.body);
  const entityId = typeof body?.entity_id === 'string' ? body.entity_id : null;
  if (!entityId) return null;
  if (service === 'turn_on' || service === 'turn_off' || service === 'toggle') {
    const before = await haState(read, entityId).catch(() => null);
    const name = entityLabel(entityId, before?.attributes.friendly_name);
    const was = before?.state;
    const now =
      service === 'toggle' ? (was === 'on' ? 'off' : was === 'off' ? 'on' : null) : service.slice(5);
    const title = now ? `Turned ${now} ${name}` : `Switched ${name}`;
    const undo =
      was === 'on' || was === 'off'
        ? {
            connectionId,
            tool: REQUEST_TOOL_NAME,
            args: {
              method: 'POST',
              path: `/api/services/${domain}/turn_${was}`,
              body: { entity_id: entityId },
            },
          }
        : null;
    return { title, undo: was === now ? null : undo };
  }
  if (domain === 'climate' && service === 'set_temperature' && typeof body?.temperature === 'number') {
    const before = await haState(read, entityId).catch(() => null);
    const name = entityLabel(entityId, before?.attributes.friendly_name);
    const old = before?.attributes.temperature;
    const unit =
      typeof before?.attributes.temperature_unit === 'string' ? before.attributes.temperature_unit : '°C';
    return {
      title: `Set ${name} to ${body.temperature} ${unit}`,
      ...(typeof old === 'number' ? { detail: `It was ${old} ${unit}.` } : {}),
      undo:
        typeof old === 'number' && old !== body.temperature
          ? {
              connectionId,
              tool: REQUEST_TOOL_NAME,
              args: {
                method: 'POST',
                path: '/api/services/climate/set_temperature',
                body: { entity_id: entityId, temperature: old },
              },
            }
          : null,
    };
  }
  return { title: `Changed ${entityLabel(entityId)} in ${label}`, undo: null };
}

/** Todoist's task fields as `tasks_update` takes them back. */
interface TodoistOld {
  id: string;
  content?: string;
  description?: string;
  due?: { date?: string; datetime?: string; text?: string };
  priority?: number;
  labels?: string[];
}

async function todoistChange(
  tool: ConnectionToolRow,
  args: Readonly<Record<string, unknown>>,
  connectionId: string,
  read: ReadTool,
): Promise<PreparedChange | null> {
  const content = typeof args.content === 'string' ? args.content.trim().slice(0, 80) : '';
  if (tool.name === 'tasks_add')
    return { title: content ? `Added the task “${content}”` : 'Added a task', undo: null };
  if (tool.name === 'tasks_complete') return { title: 'Completed a task in Todoist', undo: null };
  if (tool.name !== 'tasks_update' || typeof args.id !== 'string') return null;
  // The task as it is now, from the list (the adapter has no single-task read): its old fields undo the update.
  const listed = await read('tasks_list', {}).catch(() => null);
  const json = listed && !listed.isError ? (outputDocument(listed) as { tasks?: TodoistOld[] } | null) : null;
  const old = json?.tasks?.find((t) => String(t.id) === args.id);
  const name = old?.content ?? content;
  const undoArgs: Record<string, unknown> | null = old
    ? {
        id: old.id,
        ...(typeof args.content === 'string' && old.content !== undefined ? { content: old.content } : {}),
        ...(typeof args.description === 'string' ? { description: old.description ?? '' } : {}),
        ...(args.due !== undefined ? { due: old.due?.date ?? old.due?.text ?? 'no date' } : {}),
        ...(args.priority !== undefined && old.priority !== undefined ? { priority: old.priority } : {}),
        ...(args.labels !== undefined ? { labels: old.labels ?? [] } : {}),
      }
    : null;
  return {
    title: name ? `Updated the task “${name.slice(0, 80)}”` : 'Updated a task in Todoist',
    undo:
      undoArgs && Object.keys(undoArgs).length > 1
        ? { connectionId, tool: 'tasks_update', args: undoArgs }
        : null,
  };
}

/**
 * The change a write call will make: its title and its inverse where Whombat knows one; null for a read. Never throws:
 * a failed look at the old state leaves the change without Undo.
 */
export async function prepareConnectionChange(
  services: Services,
  row: CatalogConnectionRow,
  entry: CatalogEntry,
  tool: ConnectionToolRow,
  args: Readonly<Record<string, unknown>>,
  read: ReadTool,
  /** What the agent said the call does (`connection_call`'s `change`, HR-02). */
  agentWords?: string | null,
): Promise<PreparedChange | null> {
  // Built-in connections record their own changes (devices: SD, the Servers connection: SH): never twice.
  if (entry.id === 'device' || entry.id === 'whombat_servers') return null;
  if (connectionCallAccess(entry, tool, args) !== 'write') return null;
  const hasTool = async (name: string) => {
    const [found] = await services.db
      .select({ name: connectionTools.name })
      .from(connectionTools)
      .where(and(eq(connectionTools.connectionId, row.id), eq(connectionTools.name, name)));
    return Boolean(found);
  };
  const name = nameWithoutAddress(row.label, entry, row.fields);
  let known: PreparedChange | null = null;
  try {
    if (entry.id === 'homeassistant')
      known = await homeAssistantChange(tool, args, name, row.id, hasTool, read);
    // Todoist's own typed tools only: signed in with Todoist, its MCP server's tools are its own (SG-20).
    else if (entry.id === 'todoist' && tool.origin === 'adapter')
      known = await todoistChange(tool, args, row.id, read);
  } catch {
    known = null;
  }
  return changeTitle(known, agentWords, genericChangeTitle(tool.name, name));
}

/** The call id of an Undo: it names the change it undoes and who asked. */
export function undoCallId(changeId: string, personId: string): string {
  return `undo.${changeId}.${personId}.${newId('event').slice(-6)}`;
}

/** The change and the person an Undo's call id names, or null for any other call. */
export function parseUndoCallId(callId: string): { changeId: string; personId: string } | null {
  const parts = callId.split('.');
  if (parts.length !== 4 || parts[0] !== 'undo') return null;
  const [, changeId, personId] = parts as [string, string, string, string];
  return /^chg_/.test(changeId) && /^prn_/.test(personId) ? { changeId, personId } : null;
}

/** Where a connection change points: the connection's page. */
export function connectionChangeLink(connectionId: string): string {
  return thingHref('connection', connectionId);
}
