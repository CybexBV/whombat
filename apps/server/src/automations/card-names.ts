/**
 * The names of the ids a proposed action names (a Paperless-ngx tag, a Moneybird contact, a Todoist project), so its
 * card says “"Invoices" (7)” and not a bare number. The server reads them, never the outsiders' turn: right before the
 * `connection_actions` step makes its card, outside any transaction, as the connection, with a short deadline each, at
 * most `CARD_NAMES_MAX` reads a card, and one read for each thing however often the card names it. An id the service
 * says it doesn't have refuses the card; one it couldn't read shows as it is, with a line that says so.
 */
import { type CatalogEntry, catalogEntry, requestAllowed, vaultPathProblem } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { externalEffect } from '../commit/scope';
import { jsonOf, signedConnectionFetch } from '../connections/http';
import { connectionsFor } from '../connections/pool';
import type { CatalogConnectionRow } from '../connections/types';
import { catalogConnections, connectionTools } from '../db/schema/index';
import type { Services } from '../services';
import { outsidersCall, reportedProposedActions } from './proposed-actions';
import { CARD_NAMES_MAX, type CardNames, cardNameKey, cardRefs } from './proposed-card';
import { type AutomationRunRow, loadStepRows } from './store';

type Fields = Readonly<Record<string, string>>;

/** How long one read may take, and all of a card's together. */
const READ_DEADLINE_MS = 5_000;
const READS_BUDGET_MS = 15_000;
/** The longest answer a read takes (a list of tax rates). */
const READ_MAX_BYTES = 512 * 1024;
/** The longest name kept. */
const NAME_KEPT_MAX = 200;
/** The most items a list read asks for. */
const LIST_PAGE = 100;

/** What a read answered: its status and its JSON (null when it wasn't JSON). */
interface Answer {
  status: number;
  json: unknown;
}

/** How the name of one kind of thing is read. */
interface Lookup {
  /** The path (and query) that answers it; null when the connection lacks what the path needs. */
  path(id: string, fields: Fields): string | null;
  /** Its name in the answer; `missing` when the answer says there is no such thing; null when it can't tell. */
  name(answer: Answer, id: string): string | 'missing' | null;
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const at = (json: unknown, key: string) =>
  json && typeof json === 'object' && !Array.isArray(json)
    ? (json as Record<string, unknown>)[key]
    : undefined;

/** One thing by its own path: a 404 says there is no such thing. */
function one(path: (id: string, fields: Fields) => string | null, name: (json: unknown) => string): Lookup {
  return {
    path,
    name(answer) {
      if (answer.status === 404) return 'missing';
      if (answer.status >= 300) return null;
      return name(answer.json) || null;
    },
  };
}

/** A thing found in its list (a service without a path for one): not in a whole list says there is no such thing. */
function inList(path: (fields: Fields) => string | null, name: (item: unknown) => string): Lookup {
  return {
    path: (_id, fields) => path(fields),
    name(answer, id) {
      if (answer.status >= 300 || !Array.isArray(answer.json)) return null;
      const found = answer.json.find((item) => String(at(item, 'id') ?? '') === id);
      if (found) return name(found) || null;
      return answer.json.length < LIST_PAGE ? 'missing' : null;
    },
  };
}

const segment = (id: string) => encodeURIComponent(id);

/** Moneybird's paths are in the connection's administration. */
function administration(fields: Fields, rest: string): string | null {
  const id = text(fields.administration);
  return id ? `/${segment(id)}${rest}` : null;
}

const named = (json: unknown) => text(at(json, 'name'));

const LOOKUPS: Readonly<Record<string, Readonly<Record<string, Lookup>>>> = {
  paperless: {
    tag: one((id) => `/api/tags/${segment(id)}/`, named),
    correspondent: one((id) => `/api/correspondents/${segment(id)}/`, named),
    document_type: one((id) => `/api/document_types/${segment(id)}/`, named),
  },
  moneybird: {
    contact: one(
      (id, fields) => administration(fields, `/contacts/${segment(id)}.json`),
      (json) =>
        text(at(json, 'company_name')) ||
        `${text(at(json, 'firstname'))} ${text(at(json, 'lastname'))}`.trim(),
    ),
    ledger_account: one(
      (id, fields) => administration(fields, `/ledger_accounts/${segment(id)}.json`),
      named,
    ),
    // Moneybird lists its tax rates but has no path for one.
    tax_rate: inList((fields) => administration(fields, `/tax_rates.json?per_page=${LIST_PAGE}`), named),
  },
  todoist: {
    project: one((id) => `/api/v1/projects/${segment(id)}`, named),
  },
};

/** The way a kind of thing's name is read on a kind of connection, if Whombat knows one. */
export function nameLookup(catalogId: string, kind: string): Lookup | null {
  return LOOKUPS[catalogId]?.[kind] ?? null;
}

/** One GET as the connection, in one of its call slots; null when it couldn't be read. */
async function readOnce(
  services: Services,
  row: CatalogConnectionRow,
  entry: CatalogEntry,
  path: string,
): Promise<Answer | null> {
  const bare = path.split('?')[0] ?? '';
  if (vaultPathProblem(bare) || !requestAllowed(entry, row.fields, 'GET', bare)) return null;
  const slots = connectionsFor(services);
  if (!slots.acquire(row.id)) return null;
  try {
    const res = await externalEffect(
      'connections.card_names',
      () =>
        signedConnectionFetch(
          services,
          row,
          {
            method: 'GET',
            url: `${row.baseUrl.replace(/\/+$/, '')}${path}`,
            headers: { ...(entry.request?.headers ?? {}), Accept: 'application/json' },
          },
          { deadlineMs: READ_DEADLINE_MS, maxBytes: READ_MAX_BYTES },
        ),
      { idempotent: true },
    );
    return { status: res.status, json: res.status < 300 ? jsonOf(res) : null };
  } catch {
    return null;
  } finally {
    slots.release(row.id);
  }
}

const clipped = (name: string) => [...name].slice(0, NAME_KEPT_MAX).join('');

/**
 * The names of the ids the actions proposed in step `from` name, as the services have them now (`CardNames`). Never
 * throws: a card whose names couldn't be read shows the ids.
 */
export async function readCardNames(
  services: Services,
  run: Pick<AutomationRunRow, 'id' | 'burrowId'>,
  step: { from: string },
): Promise<CardNames> {
  const names: CardNames = {};
  try {
    const steps = await loadStepRows(services.db, run.id);
    const proposed = reportedProposedActions(
      (steps.find((s) => s.stepId === step.from)?.output as { proposedActions?: unknown } | null)
        ?.proposedActions,
    );
    if (!proposed.length) return names;
    const rows = await services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.burrowId, run.burrowId));
    const byHandle = new Map(rows.map((c) => [c.handle.toLowerCase(), c]));
    // One read for each path, however often the card names it (a tax rate on every line).
    const answers = new Map<string, Promise<Answer | null>>();
    const started = Date.now();
    for (const item of proposed) {
      const row = byHandle.get(item.connection.trim().toLowerCase());
      const entry = row ? catalogEntry(row.catalogId) : null;
      if (!row || !entry || row.status !== 'active') continue;
      const [tool] = await services.db
        .select()
        .from(connectionTools)
        .where(and(eq(connectionTools.connectionId, row.id), eq(connectionTools.name, item.tool)));
      if (!tool) continue;
      // The ids as they would be sent, so the card names what runs.
      const call = outsidersCall(entry, row, tool, item.arguments, row.label);
      if (!call.ok) continue;
      for (const ref of cardRefs(row.catalogId, tool, call.args)) {
        const key = cardNameKey(row.id, ref.kind, ref.id);
        if (Object.hasOwn(names, key)) continue;
        const lookup = nameLookup(row.catalogId, ref.kind);
        const path = lookup?.path(ref.id, row.fields);
        if (!lookup || !path) continue;
        let answer = answers.get(path);
        if (!answer) {
          if (answers.size >= CARD_NAMES_MAX || Date.now() - started > READS_BUDGET_MS) continue;
          answer = readOnce(services, row, entry, path);
          answers.set(path, answer);
        }
        const read = await answer;
        const name = read ? lookup.name(read, ref.id) : null;
        if (name === 'missing') names[key] = { missing: true };
        else if (name) names[key] = { name: clipped(name) };
        if (Object.keys(names).length >= CARD_NAMES_MAX) return names;
      }
    }
  } catch (err) {
    services.log.warn(
      { err: err instanceof Error ? err.name : 'error', runId: run.id },
      'automation: the names on a card unread',
    );
  }
  return names;
}
