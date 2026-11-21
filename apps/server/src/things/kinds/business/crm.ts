/**
 * HubSpot's and Pipedrive's page, one shape (service-dashboards.md SD-63, SD-S18), in slots (service-slots.md): the
 * overdue tasks or activities with **Done** in Live (an everyday button, SD-08), the deals (open and what they are
 * worth, won this month, new contacts or deals in 7 days, each with what changed this week), new contacts (HubSpot) or
 * new deals (Pipedrive) per day this week; the pipeline's stages and the biggest open deals below; tasks more than a
 * week overdue in Worth a look. Read with the connection's key, kept 5 minutes (Pipedrive's calls cost tokens of
 * a daily budget, SD-S05) and read again at once after a button:
 *
 * - HubSpot: the deal pipelines (`/crm/v3/pipelines/deals`, kept 15 minutes), open deals and this month's won ones through
 *   `POST /crm/v3/objects/deals/search` (the amounts added up here, with when each was made or closed), the newest 200
 *   contacts made in 14 days (`createdate`, newest first),
 *   overdue tasks (not completed, due before now) and their deals (`/crm/v4/associations/tasks/deals/batch/read`),
 *   the account's currency and web address (`/account-info/v3/details`, kept 15 minutes).
 * - Pipedrive: API v2 (v1's deals and activities are gone since 1 August 2026) — stages and pipelines (kept 15 minutes),
 *   open deals and the deals changed since the month's start or 14 days, cursor-paged; open activities (overdue ones
 *   picked here); the company's address from `/v1/users/me` (kept 15 minutes).
 *
 * Tasks by their subject, with their deal's name.
 */
import type { ThingLine, ThingPageBar, ThingPageItem, ThingPageKpi, ThingPagePanel } from '@whombat/core';
import type { CatalogConnectionRow } from '../../../connections/types';
import type { Services } from '../../../services';
import type { KindCheck } from '../../quiet/types';
import { clip, line, list, num, plural, rec, str, thousands, when } from '../../words';
import { actAs } from '../act';
import { cachedRead, latestRead } from '../read';
import type { KindAction, KindModule } from '../registry';
import {
  countByDay,
  countLine,
  daysWith,
  type InventoryPanel,
  inventory,
  type LivePanel,
  liveList,
  lastDays as slotDays,
  slotPanels,
  type TrendPanel,
  trend,
  weekChange,
} from '../slots';
import { fixed, itemLines, type KindNotice } from '../storage/lines';
import type { KindCtx, KindView } from '../types';
import {
  addTo,
  bumpGeneration,
  buttonsFor,
  daysBetween,
  dayWords,
  generationOf,
  lastDays,
  loader,
  localDay,
  type MakeButton,
  mainCurrency,
  money,
  monthStart,
  optional,
  quoted,
  rarelyRead,
  readJson,
  type Sums,
  seenOfView,
  stale,
  startOfDay,
  statusFrom,
  viewOrProblem,
} from './common';

const DAY = 86_400_000;
/** HubSpot's searches and Pipedrive's token-priced calls are kept 5 minutes (SD-S05). */
export const CRM_CACHE_MS = 5 * 60_000;
/** Rows of Overdue. */
const OVERDUE_ROWS = 10;
/** Overdue for longer than this is worth a look (SD-63). */
export const OVERDUE_WARN_DAYS = 7;

export type CrmService = 'hubspot' | 'pipedrive';
const NAMES: Record<CrmService, string> = { hubspot: 'HubSpot', pipedrive: 'Pipedrive' };

/* What both read ---------------------------------------------------------------------------------------------------- */

export interface CrmStage {
  id: string;
  label: string;
  pipeline: string | null;
  /** Its pipeline's place, then its own. */
  order: number;
  count: number;
  amount: number;
}

export interface CrmDeal {
  id: string;
  name: string;
  amount: number;
  /** Its stage's name, with its pipeline's when there are several. */
  stage: string | null;
}

/** Open deals Biggest shows at most. */
const BIGGEST = 5;
/** How far back new contacts or deals are read for the Trend: this week and the one before. */
export const MADE_DAYS = 14;

/** A date from an ISO time or epoch milliseconds; null otherwise. */
const timeOf = (v: unknown): Date | null => {
  const t = typeof v === 'number' ? v : Date.parse(str(v) ?? '');
  return Number.isFinite(t) ? new Date(t) : null;
};

/** The biggest open deals, by their worth in the main currency. */
function biggestOf(deals: (CrmDeal & { inMain: boolean })[]): CrmDeal[] {
  return deals
    .filter((d) => d.inMain && d.amount > 0)
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name))
    .slice(0, BIGGEST)
    .map(({ inMain: _, ...d }) => d);
}

/** A stage's words for a deal: its name, with its pipeline's when there are several. */
const stageWords = (stages: Map<string, CrmStage>, pipelines: number, id: string | null) => {
  const x = id ? stages.get(id) : undefined;
  if (!x) return null;
  return pipelines > 1 && x.pipeline ? `${x.label} · ${x.pipeline}` : x.label;
};

export interface CrmTask {
  id: string;
  subject: string;
  due: Date;
  deal: { id: string; name: string | null } | null;
}

export interface CrmSnapshot {
  service: CrmService;
  readAt: Date;
  currency: string;
  /** Open stages in order, each with its open deals. */
  stages: CrmStage[];
  /** Pipelines with open stages (a stage's pipeline is named only when there are several). */
  pipelines: number;
  open: { count: number; amount: number; capped: boolean };
  won: { count: number; amount: number } | null;
  /** HubSpot: contacts made in 7 days; Pipedrive: deals added in 7 days. */
  newCount: number | null;
  /**
   * When those contacts (HubSpot) or deals (Pipedrive) of the last 14 days were made, for the Trend; `whole` when every
   * one was read (HubSpot reads the newest 200). Null when not read.
   */
  made: { at: Date[]; whole: boolean } | null;
  /** Open deals made and deals won in the last 7 days; null when the read doesn't say. */
  week: { opened: number | null; won: number | null };
  /** The biggest open deals in the main currency, the biggest first. */
  biggest: CrmDeal[];
  /** `capped`: more were overdue than were read (HubSpot's 20 oldest, Pipedrive's first pages), QN-11. */
  overdue: { total: number; tasks: CrmTask[]; capped: boolean } | null;
  /** The service's own pages: home, and a deal's page when its address is known (`{id}` is replaced). */
  links: { home: string; deal: string | null; tasks: string | null };
}

/* HubSpot ---------------------------------------------------------------------------------------------------------- */

const HUBSPOT_SEARCH_PAGE = 200;
const HUBSPOT_DEAL_PAGES = 3;

type Post = (path: string, body: unknown) => Promise<unknown>;

/** Every page of a HubSpot search (up to `pages`), with its `total`. */
async function hubspotSearch(
  post: Post,
  type: string,
  body: Record<string, unknown>,
  pages: number,
): Promise<{ results: Record<string, unknown>[]; total: number; capped: boolean }> {
  const results: Record<string, unknown>[] = [];
  let after: string | null = null;
  let total = 0;
  for (let page = 0; page < pages; page++) {
    const answer = rec(
      await post(`/crm/v3/objects/${type}/search`, {
        ...body,
        limit: HUBSPOT_SEARCH_PAGE,
        ...(after ? { after } : {}),
      }),
    );
    total = num(answer.total) ?? total;
    results.push(...list(answer.results).map(rec));
    after = str(rec(rec(answer.paging).next).after);
    if (!after) return { results, total, capped: false };
  }
  return { results, total, capped: true };
}

/** Overdue as read: capped when the service has more than were read, or the read stopped early. */
function overdueOf(total: number, tasks: CrmTask[], stopped: boolean): NonNullable<CrmSnapshot['overdue']> {
  return { total, tasks, capped: stopped || total > tasks.length };
}

/** HubSpot's search bodies (SD-63). */
export function hubspotSearches(now: Date, timeZone: string) {
  const dealProps = [
    'amount',
    'amount_in_home_currency',
    'deal_currency_code',
    'dealname',
    'dealstage',
    'pipeline',
    'closedate',
    'createdate',
  ];
  return {
    open: {
      filterGroups: [{ filters: [{ propertyName: 'hs_is_closed', operator: 'EQ', value: 'false' }] }],
      properties: dealProps,
    },
    won: {
      filterGroups: [
        {
          filters: [
            { propertyName: 'hs_is_closed_won', operator: 'EQ', value: 'true' },
            {
              propertyName: 'closedate',
              operator: 'GTE',
              value: String(monthStart(now, timeZone).getTime()),
            },
          ],
        },
      ],
      properties: dealProps,
    },
    // The newest 200 contacts of 14 days, the most one search page holds: this week's per day, and the week before.
    contacts: {
      filterGroups: [
        {
          filters: [
            { propertyName: 'createdate', operator: 'GTE', value: String(now.getTime() - MADE_DAYS * DAY) },
          ],
        },
      ],
      properties: ['createdate'],
      sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
      limit: 200,
    },
    tasks: {
      filterGroups: [
        {
          filters: [
            { propertyName: 'hs_task_status', operator: 'NEQ', value: 'COMPLETED' },
            { propertyName: 'hs_timestamp', operator: 'LT', value: String(now.getTime()) },
          ],
        },
      ],
      properties: ['hs_task_subject', 'hs_timestamp', 'hs_task_status'],
      sorts: [{ propertyName: 'hs_timestamp', direction: 'ASCENDING' }],
      limit: 20,
    },
  };
}

/** A HubSpot deal's worth in the account's currency (`amount_in_home_currency`, else `amount`). */
const hubspotAmount = (props: Record<string, unknown>) =>
  num(props.amount_in_home_currency) ?? num(props.amount) ?? 0;

/** HubSpot's pipelines: their open stages in order, by stage id. */
export function hubspotStages(body: unknown): {
  stages: Map<string, CrmStage>;
  pipelines: Map<string, string>;
} {
  const stages = new Map<string, CrmStage>();
  const pipelines = new Map<string, string>();
  const ordered = list(rec(body).results)
    .map(rec)
    .sort((a, b) => (num(a.displayOrder) ?? 0) - (num(b.displayOrder) ?? 0));
  ordered.forEach((p, pi) => {
    const pid = str(p.id);
    if (!pid) return;
    const label = str(p.label) ?? pid;
    pipelines.set(pid, label.slice(0, 60));
    for (const s of list(p.stages).map(rec)) {
      const id = str(s.id);
      if (!id || str(rec(s.metadata).isClosed) === 'true' || s.archived === true) continue;
      stages.set(id, {
        id,
        label: (str(s.label) ?? id).slice(0, 80),
        pipeline: label.slice(0, 60),
        order: pi * 1000 + (num(s.displayOrder) ?? 0),
        count: 0,
        amount: 0,
      });
    }
  });
  return { stages, pipelines };
}

/** HubSpot's overdue tasks from the search. */
export function hubspotTasks(results: unknown[]): CrmTask[] {
  return results
    .map((raw): CrmTask | null => {
      const r = rec(raw);
      const p = rec(r.properties);
      const id = str(r.id) ?? str(p.hs_object_id);
      const due = num(p.hs_timestamp) ?? Date.parse(str(p.hs_timestamp) ?? '');
      if (!id || !Number.isFinite(due)) return null;
      return {
        id: id.slice(0, 60),
        subject: (str(p.hs_task_subject) ?? 'A task').slice(0, 160),
        due: new Date(due),
        deal: null,
      };
    })
    .filter((t): t is CrmTask => t !== null);
}

/** Puts open deals into their stages; returns the open count and amount. */
function intoStages(
  stages: Map<string, CrmStage>,
  deals: { stage: string | null; amount: number }[],
): { count: number; amount: number } {
  let count = 0;
  let amount = 0;
  for (const d of deals) {
    count++;
    amount += d.amount;
    const s = d.stage ? stages.get(d.stage) : undefined;
    if (s) {
      s.count++;
      s.amount += d.amount;
    }
  }
  return { count, amount };
}

/** What HubSpot answered, for `hubspotSnapshot`. */
export interface HubspotAnswers {
  account: unknown;
  pipelines: unknown;
  open: { results: Record<string, unknown>[]; capped: boolean };
  won: { results: Record<string, unknown>[]; total: number } | null;
  contacts: unknown;
  tasks: unknown;
  /** `/crm/v4/associations/tasks/deals/batch/read` for the overdue tasks. */
  associations: unknown;
  /** `/crm/v3/objects/deals/batch/read` for their deals that aren't open. */
  deals: unknown;
}

/** The deal each task is about (the first one), from the associations' answer. */
export function taskDeals(body: unknown): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of list(rec(body).results).map(rec)) {
    const from = str(rec(r.from).id);
    const to = rec(list(r.to)[0]).toObjectId;
    if (from && (typeof to === 'number' || typeof to === 'string')) out.set(from, String(to));
  }
  return out;
}

const dealNamesOf = (results: unknown[]) => {
  const out = new Map<string, string>();
  for (const d of results.map(rec)) {
    const id = str(d.id);
    const dealname = str(rec(d.properties).dealname);
    if (id && dealname) out.set(id, dealname.slice(0, 160));
  }
  return out;
};

/** HubSpot's snapshot from its answers; pure. */
export function hubspotSnapshot(a: HubspotAnswers, now: Date): CrmSnapshot {
  const { stages, pipelines: names } = hubspotStages(a.pipelines);
  const dealNames = new Map([...dealNamesOf(a.open.results), ...dealNamesOf(list(rec(a.deals).results))]);
  const totals = intoStages(
    stages,
    a.open.results.map((d) => {
      const p = rec(d.properties);
      return { stage: str(p.dealstage), amount: hubspotAmount(p) };
    }),
  );
  const tasks = (a.tasks ? hubspotTasks(list(rec(a.tasks).results)) : []).sort(
    (x, y) => x.due.getTime() - y.due.getTime(),
  );
  const dealOf = taskDeals(a.associations);
  for (const t of tasks) {
    const id = dealOf.get(t.id);
    if (id) t.deal = { id, name: dealNames.get(id) ?? null };
  }
  const account = rec(a.account);
  const domain = str(account.uiDomain) ?? 'app.hubspot.com';
  const portal = num(account.portalId);
  const weekAgo = now.getTime() - 7 * DAY;
  const madeAt = (r: Record<string, unknown>) => timeOf(r.createdAt) ?? timeOf(rec(r.properties).createdate);
  const contacts = a.contacts ? list(rec(a.contacts).results).map(rec) : null;
  const made = contacts
    ? {
        at: contacts.map(madeAt).filter((d): d is Date => d !== null),
        whole: contacts.length >= (num(rec(a.contacts).total) ?? 0),
      }
    : null;
  return {
    service: 'hubspot',
    readAt: now,
    currency: str(account.companyCurrency)?.toUpperCase() ?? 'EUR',
    stages: [...stages.values()].sort((x, y) => x.order - y.order),
    pipelines: names.size,
    open: { ...totals, capped: a.open.capped },
    won: a.won
      ? {
          count: a.won.total,
          amount: a.won.results.reduce((sum, d) => sum + hubspotAmount(rec(d.properties)), 0),
        }
      : null,
    newCount: made ? made.at.filter((d) => d.getTime() >= weekAgo).length : null,
    made,
    week: {
      opened: a.open.results.filter((d) => (madeAt(d)?.getTime() ?? 0) >= weekAgo).length,
      won: a.won
        ? a.won.results.filter((d) => (timeOf(rec(d.properties).closedate)?.getTime() ?? 0) >= weekAgo).length
        : null,
    },
    biggest: biggestOf(
      a.open.results.map((d) => {
        const p = rec(d.properties);
        return {
          id: str(d.id) ?? '',
          name: (str(p.dealname) ?? 'A deal').slice(0, 160),
          amount: hubspotAmount(p),
          stage: stageWords(stages, names.size, str(p.dealstage)),
          inMain: !!str(d.id),
        };
      }),
    ),
    overdue: a.tasks ? overdueOf(num(rec(a.tasks).total) ?? tasks.length, tasks, false) : null,
    links: {
      home: `https://${domain}/`,
      deal: portal ? `https://${domain}/contacts/${portal}/record/0-3/{id}` : null,
      tasks: portal ? `https://${domain}/tasks/${portal}/view/all` : null,
    },
  };
}

async function readHubspot(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
  timeZone: string,
): Promise<CrmSnapshot> {
  const name = NAMES.hubspot;
  const post: Post = (path, body) => readJson(services, row, name, path, { method: 'POST', body });
  const q = hubspotSearches(now, timeZone);
  const rarely = (key: string, path: string, canFail = false) =>
    rarelyRead(services, `hubspot-${key}:${row.id}`, row, () => readJson(services, row, name, path), {
      optional: canFail,
    });
  const [account, pipelines, open, won, contacts, tasks] = await Promise.all([
    rarely('account', '/account-info/v3/details', true),
    rarely('pipelines', '/crm/v3/pipelines/deals'),
    hubspotSearch(post, 'deals', q.open, HUBSPOT_DEAL_PAGES),
    optional(hubspotSearch(post, 'deals', q.won, 2)),
    optional(post('/crm/v3/objects/contacts/search', q.contacts)),
    optional(post('/crm/v3/objects/tasks/search', q.tasks)),
  ]);
  // Which deal each overdue task is about (one call), and the names of those deals that aren't open (one more).
  const ids = tasks ? hubspotTasks(list(rec(tasks).results)).map((t) => ({ id: t.id })) : [];
  const associations = ids.length
    ? await optional(post('/crm/v4/associations/tasks/deals/batch/read', { inputs: ids }))
    : null;
  const known = dealNamesOf(open.results);
  const missing = [...new Set(taskDeals(associations).values())].filter((id) => !known.has(id));
  const deals = missing.length
    ? await optional(
        post('/crm/v3/objects/deals/batch/read', {
          properties: ['dealname'],
          inputs: missing.map((id) => ({ id })),
        }),
      )
    : null;
  return hubspotSnapshot({ account, pipelines, open, won, contacts, tasks, associations, deals }, now);
}

/* Pipedrive -------------------------------------------------------------------------------------------------------- */

const PIPEDRIVE_PAGE = 500;

type Get = (path: string, query: Record<string, string>) => Promise<unknown>;

/** Every page of a Pipedrive v2 list (up to `pages`), following `additional_data.next_cursor`. */
async function pipedriveList(
  get: Get,
  path: string,
  query: Record<string, string>,
  pages: number,
): Promise<{ data: Record<string, unknown>[]; capped: boolean }> {
  const data: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < pages; page++) {
    const answer = rec(
      await get(path, { ...query, limit: String(PIPEDRIVE_PAGE), ...(cursor ? { cursor } : {}) }),
    );
    data.push(...list(answer.data).map(rec));
    cursor = str(rec(answer.additional_data).next_cursor);
    if (!cursor) return { data, capped: false };
  }
  return { data, capped: true };
}

/** Pipedrive's stages (v2), in their pipeline's order, by id. */
export function pipedriveStages(
  stagesBody: unknown,
  pipelinesBody: unknown,
): {
  stages: Map<string, CrmStage>;
  pipelines: Map<string, string>;
} {
  const pipelines = new Map<string, string>();
  const pipelineOrder = new Map<string, number>();
  for (const p of list(rec(pipelinesBody).data).map(rec)) {
    const id = p.id == null ? null : String(p.id);
    if (!id || p.is_deleted === true) continue;
    pipelines.set(id, (str(p.name) ?? id).slice(0, 60));
    pipelineOrder.set(id, num(p.order_nr) ?? 0);
  }
  const stages = new Map<string, CrmStage>();
  for (const s of list(rec(stagesBody).data).map(rec)) {
    const id = s.id == null ? null : String(s.id);
    if (!id || s.is_deleted === true) continue;
    const pid = s.pipeline_id == null ? null : String(s.pipeline_id);
    stages.set(id, {
      id,
      label: (str(s.name) ?? id).slice(0, 80),
      pipeline: pid ? (pipelines.get(pid) ?? null) : null,
      order: (pid ? (pipelineOrder.get(pid) ?? 0) : 0) * 1000 + (num(s.order_nr) ?? 0),
      count: 0,
      amount: 0,
    });
  }
  return { stages, pipelines };
}

/** When a Pipedrive activity is due: its date, with its time (UTC) when it has one, else the end of that local day. */
export function pipedriveDue(a: Record<string, unknown>, timeZone: string): Date | null {
  const date = str(a.due_date);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const time = str(a.due_time);
  if (time && /^\d{2}:\d{2}/.test(time)) return new Date(`${date}T${time.slice(0, 5)}:00Z`);
  return new Date(startOfDay(date, timeZone).getTime() + DAY - 1);
}

/** What Pipedrive answered, for `pipedriveSnapshot`. */
export interface PipedriveAnswers {
  me: unknown;
  stages: unknown;
  pipelines: unknown;
  open: { data: Record<string, unknown>[]; capped: boolean };
  /** The deals changed since the month's start or 7 days (won ones, new ones). */
  recent: { data: Record<string, unknown>[]; capped?: boolean } | null;
  activities: { data: Record<string, unknown>[]; capped?: boolean } | null;
}

/**
 * Since when Pipedrive's changed deals are read: the month's start or 14 days ago, the earlier. A deal added since then
 * has changed since then too, so the read holds every new deal of this week and the one before.
 */
export function pipedriveSince(now: Date, timeZone: string): Date {
  return new Date(Math.min(monthStart(now, timeZone).getTime(), now.getTime() - MADE_DAYS * DAY));
}

/** Pipedrive's snapshot from its answers; pure. */
export function pipedriveSnapshot(a: PipedriveAnswers, now: Date, timeZone: string): CrmSnapshot {
  const { stages, pipelines } = pipedriveStages(a.stages, a.pipelines);
  const sums: Sums = new Map();
  for (const d of a.open.data) addTo(sums, str(d.currency)?.toUpperCase() ?? 'EUR', num(d.value) ?? 0);
  const user = rec(rec(a.me).data);
  const currency = mainCurrency(sums, str(user.default_currency)?.toUpperCase() ?? 'EUR');
  // Deals in another currency count, but only the main currency's are added up.
  const inCurrency = (d: Record<string, unknown>) =>
    (str(d.currency)?.toUpperCase() ?? currency) === currency ? (num(d.value) ?? 0) : 0;
  const titles = new Map<string, string>();
  const totals = intoStages(
    stages,
    a.open.data.map((d) => {
      const title = str(d.title);
      if (d.id != null && title) titles.set(String(d.id), title.slice(0, 160));
      return { stage: d.stage_id == null ? null : String(d.stage_id), amount: inCurrency(d) };
    }),
  );
  const month = monthStart(now, timeZone).getTime();
  const week = now.getTime() - 7 * DAY;
  let won: CrmSnapshot['won'] = null;
  let added: number | null = null;
  let wonWeek: number | null = null;
  let made: CrmSnapshot['made'] = null;
  if (a.recent) {
    won = { count: 0, amount: 0 };
    added = 0;
    wonWeek = 0;
    made = { at: [], whole: a.recent.capped !== true };
    const from = now.getTime() - MADE_DAYS * DAY;
    for (const d of a.recent.data) {
      if (d.is_deleted === true) continue;
      const wonAt = Date.parse(str(d.won_time) ?? '');
      if (d.status === 'won' && wonAt >= month) {
        won.count++;
        won.amount += inCurrency(d);
      }
      if (d.status === 'won' && wonAt >= week) wonWeek++;
      const addedAt = Date.parse(str(d.add_time) ?? '');
      if (addedAt >= week) added++;
      if (addedAt >= from) made.at.push(new Date(addedAt));
    }
  }
  let overdue: CrmSnapshot['overdue'] = null;
  if (a.activities) {
    const tasks: CrmTask[] = [];
    for (const x of a.activities.data) {
      if (x.done === true || x.is_deleted === true || x.id == null) continue;
      const due = pipedriveDue(x, timeZone);
      if (!due || due >= now) continue;
      const deal = x.deal_id == null ? null : String(x.deal_id);
      tasks.push({
        id: String(x.id).slice(0, 60),
        subject: (str(x.subject) ?? 'An activity').slice(0, 160),
        due,
        deal: deal ? { id: deal, name: titles.get(deal) ?? null } : null,
      });
    }
    tasks.sort((x, y) => x.due.getTime() - y.due.getTime());
    overdue = overdueOf(tasks.length, tasks.slice(0, 20), a.activities.capped === true);
  }
  const company = str(user.company_domain);
  return {
    service: 'pipedrive',
    readAt: now,
    currency,
    stages: [...stages.values()].sort((x, y) => x.order - y.order),
    pipelines: pipelines.size || new Set([...stages.values()].map((x) => x.pipeline)).size,
    open: { ...totals, capped: a.open.capped },
    won,
    newCount: added,
    made,
    week: {
      opened: a.open.data.filter((d) => Date.parse(str(d.add_time) ?? '') >= week).length,
      won: wonWeek,
    },
    biggest: biggestOf(
      a.open.data.map((d) => ({
        id: d.id == null ? '' : String(d.id),
        name: (str(d.title) ?? 'A deal').slice(0, 160),
        amount: num(d.value) ?? 0,
        stage: stageWords(stages, pipelines.size, d.stage_id == null ? null : String(d.stage_id)),
        inMain: d.id != null && (str(d.currency)?.toUpperCase() ?? currency) === currency,
      })),
    ),
    overdue,
    links: {
      home: company ? `https://${company}.pipedrive.com/` : 'https://app.pipedrive.com/',
      deal: company ? `https://${company}.pipedrive.com/deal/{id}` : null,
      tasks: company ? `https://${company}.pipedrive.com/activities/list` : null,
    },
  };
}

async function readPipedrive(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
  timeZone: string,
): Promise<CrmSnapshot> {
  const name = NAMES.pipedrive;
  const get: Get = (path, query) => readJson(services, row, name, path, { query });
  const rarely = (key: string, path: string, query: Record<string, string>, canFail = false) =>
    rarelyRead(services, `pipedrive-${key}:${row.id}`, row, () => get(path, query), { optional: canFail });
  const since = pipedriveSince(now, timeZone)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');
  const [me, stages, pipelines, open, recent, activities] = await Promise.all([
    rarely('me', '/v1/users/me', {}, true),
    rarely('stages', '/api/v2/stages', { limit: '500' }),
    rarely('pipelines', '/api/v2/pipelines', { limit: '100' }, true),
    pipedriveList(get, '/api/v2/deals', { status: 'open' }, 3),
    optional(pipedriveList(get, '/api/v2/deals', { updated_since: since }, 2)),
    optional(pipedriveList(get, '/api/v2/activities', { done: 'false' }, 2)),
  ]);
  return pipedriveSnapshot({ me, stages, pipelines, open, recent, activities }, now, timeZone);
}

/* Reading, both ---------------------------------------------------------------------------------------------------- */

const keyOf = (service: CrmService, row: CatalogConnectionRow, timeZone: string) =>
  `${service}:${row.id}:${timeZone}:${generationOf(row.id)}`;

function crmLoad(
  service: CrmService,
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
  timeZone: string,
) {
  return loader(NAMES[service], () =>
    service === 'hubspot'
      ? readHubspot(services, row, now, timeZone)
      : readPipedrive(services, row, now, timeZone),
  );
}

/** A CRM's read for its page (PS-01), kept 5 minutes, read again after a button. */
export function crmLatest(
  service: CrmService,
  services: Services,
  row: CatalogConnectionRow,
  now = services.clock(),
  timeZone = 'UTC',
) {
  return latestRead(
    services,
    keyOf(service, row, timeZone),
    row,
    crmLoad(service, services, row, now, timeZone),
    {
      ttlMs: CRM_CACHE_MS,
    },
  );
}

/** The read a button checks its target against (the page's, unless it is older than 5 minutes). */
function crmSnapshot(
  service: CrmService,
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
  timeZone: string,
) {
  return cachedRead(
    services,
    keyOf(service, row, timeZone),
    row,
    crmLoad(service, services, row, now, timeZone),
    CRM_CACHE_MS,
  );
}

/* What it shows ------------------------------------------------------------------------------------------------------ */

export interface CrmInput {
  snapshot: CrmSnapshot;
  now: Date;
  timeZone: string;
  /** The page's buttons; absent for the card (no buttons there). */
  button?: MakeButton;
}

const TASK_WORD: Record<CrmService, { one: string; label: string }> = {
  hubspot: { one: 'task', label: 'Overdue tasks' },
  pipedrive: { one: 'activity', label: 'Overdue activities' },
};

/** A deal's page in the service, when its address is known. */
export const dealUrl = (s: CrmSnapshot, id: string) =>
  s.links.deal ? s.links.deal.replace('{id}', encodeURIComponent(id)) : null;

/** How long ago something was due: “3 days”, “Today 10:00”. */
function dueWords(due: Date, now: Date, timeZone: string): string {
  const days = daysBetween(
    startOfDay(localDay(due, timeZone), timeZone),
    startOfDay(localDay(now, timeZone), timeZone),
  );
  return days >= 1 ? `${dayWords(days)} ago` : when(due, now, timeZone);
}

/** “Oldest 3 days ago”, “Due earlier today”. */
function oldestWords(due: Date, input: Pick<CrmInput, 'now' | 'timeZone'>): string {
  const words = dueWords(due, input.now, input.timeZone);
  return words.endsWith(' ago') ? `Oldest ${words}` : 'Due earlier today';
}

function figures(input: CrmInput): ThingPageKpi[] {
  const { snapshot: s } = input;
  const c = s.currency;
  const out: ThingPageKpi[] = [
    {
      key: 'open',
      label: 'Open deals',
      value: money(s.open.amount, c),
      sub: `${thousands(s.open.count)}${s.open.capped ? '+' : ''} ${s.open.count === 1 ? 'deal' : 'deals'}`,
      color: 'blue',
    },
  ];
  if (s.won)
    out.push({
      key: 'won',
      label: 'Won this month',
      value: money(s.won.amount, c),
      sub: plural(s.won.count, 'deal'),
      color: 'green',
    });
  if (s.newCount !== null)
    out.push({
      key: 'new',
      label: s.service === 'hubspot' ? 'New contacts' : 'New deals',
      value: thousands(s.newCount),
      sub: 'Last 7 days',
    });
  if (s.overdue) {
    const old = oldTasks(input).length;
    out.push({
      key: 'overdue',
      label: TASK_WORD[s.service].label,
      value: thousands(s.overdue.total),
      sub: s.overdue.total
        ? old
          ? `${old} over a week`
          : oldestWords(s.overdue.tasks[0]?.due ?? input.now, input)
        : 'Nothing overdue',
      ...(old ? { tone: 'warn' as const } : {}),
    });
  }
  return out;
}

/** The tasks more than a week overdue. */
function oldTasks(input: CrmInput): CrmTask[] {
  return (input.snapshot.overdue?.tasks ?? []).filter(
    (t) => input.now.getTime() - t.due.getTime() > OVERDUE_WARN_DAYS * DAY,
  );
}

/** Pipeline (SD-63): open stages as bars with their count and worth. */
export function pipelineBars(input: CrmInput): ThingPageBar[] {
  const { snapshot: s } = input;
  const top = Math.max(...s.stages.map((x) => x.amount), 0);
  const topCount = Math.max(...s.stages.map((x) => x.count), 1);
  return s.stages.slice(0, 40).map((x) => ({
    id: `stage-${x.id}`.slice(0, 200),
    label: clip(x.label, 80),
    ...(s.pipelines > 1 && x.pipeline ? { note: clip(x.pipeline, 80) } : {}),
    value: `${x.count} · ${money(x.amount, s.currency)}`.slice(0, 40),
    pct: top > 0 ? Math.min(1, x.amount / top) : Math.min(1, x.count / topCount),
  }));
}

/**
 * Worth a look (SD-63; quiet-notices.md QN-S*): each task more than a week overdue, the oldest first, as a heads-up — a
 * to-do list is its owner's business, so it never colours the dot (as Todoist's) — and Ignore lasts until it's done or
 * no longer a week late. The read doesn't say whose task it is: every owner's overdue tasks count.
 */
export function crmNotices(input: CrmInput): KindNotice[] {
  const old = oldTasks(input);
  if (!old.length) return [];
  const s = input.snapshot;
  const word = TASK_WORD[s.service].one;
  const words = word === 'activity' ? 'activities' : 'tasks';
  const link = {
    kind: 'url' as const,
    label: `Open ${NAMES[s.service]}`,
    url: s.links.tasks ?? s.links.home,
  };
  const late = (t: CrmTask) => dueWords(t.due, input.now, input.timeZone).replace(/ ago$/, '');
  return itemLines(
    old,
    (t) => ({
      id: `overdue-${t.id}`.slice(0, 120),
      tone: 'warn',
      icon: 'clock',
      title: clip(`${quoted(t.subject, 60)} is ${late(t)} overdue`, 120),
      ...(t.deal?.name ? { detail: clip(`About ${t.deal.name}.`, 200) } : {}),
      link,
      nature: 'fyi',
      check: CRM_OVERDUE,
      subject: { id: `task:${t.id}`.slice(0, 160), name: clip(t.subject, 80) },
      ignore: fixed('Until it’s done.'),
    }),
    (t) => t.id,
    (rest) => ({
      id: 'overdue-more',
      tone: 'warn',
      icon: 'clock',
      title: `${plural(rest.length, `more ${word}`, `more ${words}`)} over a week overdue`,
      detail: `The oldest is ${late(rest[0] as CrmTask)} overdue.`,
      link,
      nature: 'fyi',
      check: CRM_OVERDUE,
    }),
  );
}

/** The check of an overdue task (QN-03), shared by HubSpot and Pipedrive. */
export const CRM_OVERDUE = 'crm.overdue';

/** What Whombat watches (QN-15). */
export function crmChecks(service: CrmService): KindCheck[] {
  return [
    {
      check: CRM_OVERDUE,
      name: service === 'hubspot' ? 'Tasks over a week overdue' : 'Activities over a week overdue',
      nature: 'fyi',
      perItem: true,
      startsOn: false,
    },
  ];
}

/** The checks this read couldn't see whole (QN-11): overdue not read, or more overdue than were read. */
export function crmSkipped(s: CrmSnapshot): string[] {
  return !s.overdue || s.overdue.capped ? [CRM_OVERDUE] : [];
}

/**
 * Live “Overdue”: each task or activity past due, the oldest first, with its deal and how long ago it was due (amber
 * over a week) and **Done**; linked to its deal. A to-do list the person works through, so it leads the page (its
 * Worth a look lines start off).
 */
export function overdueLive(input: CrmInput): LivePanel | null {
  const { snapshot: s, now, timeZone, button } = input;
  if (!s.overdue) return null;
  const word = TASK_WORD[s.service];
  const old = oldTasks(input).length;
  return liveList({
    id: 'overdue',
    title: 'Overdue',
    ...(s.overdue.total
      ? {
          meta: [
            `${thousands(s.overdue.total)}${s.overdue.capped ? '+' : ''} overdue`,
            old ? `${old} over a week` : null,
          ]
            .filter(Boolean)
            .join(' · '),
        }
      : {}),
    link: { kind: 'url', label: `Open ${NAMES[s.service]}`, url: s.links.tasks ?? s.links.home },
    items: s.overdue.tasks.slice(0, OVERDUE_ROWS).map((t): ThingPageItem => {
      const late = now.getTime() - t.due.getTime() > OVERDUE_WARN_DAYS * DAY;
      const url = t.deal ? dealUrl(s, t.deal.id) : null;
      const due = dueWords(t.due, now, timeZone);
      return {
        id: t.id,
        title: clip(t.subject, 160),
        detail: clip(
          [
            t.deal?.name ? `About ${t.deal.name}` : null,
            due.endsWith(' ago') ? `due ${due}` : `due ${due.toLowerCase()}`,
          ]
            .filter(Boolean)
            .join(' · '),
          300,
        ),
        icon: 'clock',
        ...(late ? { tone: 'warn' as const } : {}),
        ...(url ? { url } : {}),
        ...(button
          ? { actions: [button({ action: 'done', target: t.id, label: 'Done', icon: 'check' })] }
          : {}),
      };
    }),
    empty: `No ${word.one === 'activity' ? 'activity' : 'task'} is overdue.`,
  });
}

/** “+3 this week”, “Nothing new”; nothing when the read doesn't say. */
const weekNote = (n: number | null) =>
  n === null
    ? {}
    : n
      ? { note: `+${thousands(n)} this week`, noteTone: 'ok' as const }
      : { note: 'Nothing new' };

/** HubSpot read the newest 200 contacts and they don't reach back a week: the count is at least that. */
function newAtLeast(s: CrmSnapshot, now: Date): boolean {
  if (!s.made || s.made.whole) return false;
  const oldest = Math.min(...s.made.at.map((d) => d.getTime()));
  return oldest > now.getTime() - 7 * DAY;
}

/** Inventory “Deals”: open deals and their worth, won this month, new contacts or deals in 7 days. */
export function dealsInventory(input: CrmInput): InventoryPanel {
  const { snapshot: s, now } = input;
  const c = s.currency;
  const lines: ThingPageItem[] = [
    countLine({
      id: 'open',
      title: 'Open deals',
      icon: 'money',
      detail: `${thousands(s.open.count)}${s.open.capped ? '+' : ''} ${s.open.count === 1 ? 'deal' : 'deals'}`,
      value: money(s.open.amount, c),
      ...weekNote(s.week.opened),
      url: s.links.home,
    }),
  ];
  if (s.won)
    lines.push(
      countLine({
        id: 'won',
        title: 'Won this month',
        icon: 'money',
        detail: plural(s.won.count, 'deal'),
        value: money(s.won.amount, c),
        ...weekNote(s.week.won),
        url: s.links.home,
      }),
    );
  if (s.newCount !== null)
    lines.push(
      countLine({
        id: 'new',
        title: s.service === 'hubspot' ? 'New contacts' : 'New deals',
        icon: 'log',
        detail: 'Last 7 days',
        value: `${thousands(s.newCount)}${newAtLeast(s, now) ? '+' : ''}`,
        url: s.links.home,
      }),
    );
  return inventory({ id: 'deals', title: 'Deals', items: lines });
}

/**
 * Trend: new contacts (HubSpot) or new deals (Pipedrive) per day this week, with the change on the week before. When
 * HubSpot's newest 200 don't reach back far enough, the days before them have no bar and there is no change.
 */
export function newWeek(input: CrmInput): TrendPanel | null {
  const { snapshot: s, now, timeZone } = input;
  if (!s.made) return null;
  const days = slotDays(now, timeZone);
  const counts = countByDay(s.made.at, days.keys, timeZone);
  const oldest = s.made.whole
    ? null
    : localDay(new Date(Math.min(...s.made.at.map((d) => d.getTime()))), timeZone);
  // A day only partly read (the oldest one read) is no whole day either.
  const values = counts.map((n, i) => (oldest !== null && (days.keys[i] as string) <= oldest ? null : n));
  if (daysWith(values) < 2) return null;
  const week = values.reduce<number>((a, v) => a + (v ?? 0), 0);
  const before = s.made.whole
    ? countByDay(s.made.at, lastDays(now, timeZone, MADE_DAYS).slice(0, MADE_DAYS - 7), timeZone).reduce(
        (a, b) => a + b,
        0,
      )
    : 0;
  const what = s.service === 'hubspot' ? ['contact', 'contacts'] : ['deal', 'deals'];
  return trend({
    id: 'week',
    title: 'This week',
    meta: `New ${what[1]} per day`,
    days,
    values,
    label: `New ${what[1]}`,
    figure: { value: thousands(week), rest: `new ${week === 1 ? what[0] : what[1]} this week` },
    change: s.made.whole ? weekChange(week, before) : null,
    color: 'violet',
  });
}

/** Biggest open deals: the deal, its stage and its worth, linked to it. */
function biggestPanel(input: CrmInput): ThingPagePanel | null {
  const s = input.snapshot;
  if (!s.biggest.length) return null;
  return {
    kind: 'list',
    id: 'biggest',
    title: 'Biggest open deals',
    items: s.biggest.map((d): ThingPageItem => {
      const url = dealUrl(s, d.id);
      return {
        id: `deal-${d.id}`.slice(0, 200),
        title: clip(d.name, 160),
        ...(d.stage ? { detail: clip(d.stage, 300) } : {}),
        icon: 'money',
        right: money(d.amount, s.currency),
        ...(url ? { url } : {}),
      };
    }),
  };
}

/** The page's CRM part (SD-63), in slots (service-slots.md), from what was read; pure. */
export function crmView(input: CrmInput): KindView {
  const { snapshot: s } = input;
  const notices = crmNotices(input);
  const more: ThingPagePanel[] = [
    {
      kind: 'bars',
      id: 'pipeline',
      title: 'Pipeline',
      meta: `${thousands(s.open.count)} open · ${money(s.open.amount, s.currency)}`,
      link: { kind: 'url', label: `Open ${NAMES[s.service]}`, url: s.links.home },
      items: pipelineBars(input),
      empty: 'No open deals.',
    },
  ];
  const biggest = biggestPanel(input);
  if (biggest) more.push(biggest);
  const facts: ThingLine[] = [line(`**${thousands(s.open.count)}** open deals`)];
  if (s.won?.count) facts.push(line(`**${s.won.count}** won this month`));
  return {
    // Its figures are in Overdue and Deals; the card keeps them (`crmFigures`).
    kpis: [],
    charts: [],
    machine: 'after',
    notices,
    ...slotPanels({
      live: overdueLive(input),
      inventory: dealsInventory(input),
      trend: newWeek(input),
      more,
    }),
    tabs: [],
    facts,
    status: statusFrom(notices, s.overdue?.total ? `${s.overdue.total} overdue` : 'Nothing overdue'),
    open: { label: `Open ${NAMES[s.service]}`, url: s.links.home },
    actions: [],
    readAt: s.readAt,
    suggestions: ['Deals won this quarter', 'Deals without a next step', 'Biggest open deals'],
  };
}

/** The card's figures: open deals, won, new and overdue (as the page's row used to be). */
export const crmFigures = (input: CrmInput): ThingPageKpi[] => figures(input);

/** The card from the page and its own figures, open deals and overdue (the page in slots has no row of figures). */
export function crmSeen(input: CrmInput) {
  return seenOfView(
    { ...crmView(input), kpis: crmFigures(input) },
    ['open', 'overdue'],
    undefined,
    crmSkipped(input.snapshot),
  );
}

/* The page and Done ------------------------------------------------------------------------------------------------- */

function crmPage(service: CrmService) {
  return async (ctx: KindCtx): Promise<KindView> => {
    const read = await crmLatest(service, ctx.services, ctx.row, ctx.now, ctx.timeZone);
    const home = service === 'hubspot' ? 'https://app.hubspot.com/' : 'https://app.pipedrive.com/';
    return viewOrProblem(read, NAMES[service], { label: `Open ${NAMES[service]}`, url: home }, (snapshot) =>
      crmView({
        snapshot,
        now: ctx.now,
        timeZone: ctx.timeZone,
        button: buttonsFor(ctx),
      }),
    );
  };
}

/** **Done** on an overdue task (SD-63): only one the page shows; an everyday button (SD-08). */
function doneAction(service: CrmService): KindAction {
  return async (ctx, input) => {
    const name = NAMES[service];
    const target = typeof input.target === 'string' ? input.target : '';
    const snapshot = await crmSnapshot(service, ctx.services, ctx.row, ctx.now, ctx.timeZone);
    const task = snapshot.overdue?.tasks.find((t) => t.id === target);
    if (!task) throw stale(name);
    await actAs(
      ctx.services,
      ctx.row,
      name,
      service === 'hubspot'
        ? {
            method: 'PATCH',
            path: `/crm/v3/objects/tasks/${encodeURIComponent(task.id)}`,
            body: { properties: { hs_task_status: 'COMPLETED' } },
          }
        : {
            method: 'PATCH',
            path: `/api/v2/activities/${encodeURIComponent(task.id)}`,
            body: { done: true },
          },
    );
    bumpGeneration(ctx.row.id);
    return {
      message: `Marked done in ${name}.`,
      title: `Marked ${quoted(task.subject)} done`,
      everyday: true,
    };
  };
}

function crmKind(service: CrmService): KindModule {
  return {
    page: crmPage(service),
    prefetch: (services, row, now, timeZone) => crmLatest(service, services, row, now, timeZone),
    async seen(services, row, now, timeZone) {
      const snapshot = await crmSnapshot(service, services, row, now, timeZone);
      return crmSeen({ snapshot, now, timeZone });
    },
    checks: crmChecks(service),
    asksFirst: 'deleting and merging records ask first',
    actions: { done: doneAction(service) },
  };
}

export const HUBSPOT_KIND = crmKind('hubspot');
export const PIPEDRIVE_KIND = crmKind('pipedrive');
