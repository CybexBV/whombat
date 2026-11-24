/**
 * A connection's or device's own page (`things.page`; connection-pages.md CP-01…CP-14; connection-pages-server.md
 * CP-S01…): the server builds every panel with its words, the clients draw them by kind (CP-04). The person's accounts
 * (Google, Microsoft 365, Email, GitHub, Website feedback) have pages of their own (`accounts/`).
 *
 * - **Who sees it**: as `connections.list`, the burrow's person: every connection and device of the burrow
 *   (one-person.md OP-S50).
 * - **The head**: name, icon, status and badge, facts, address, the service's own page, what it runs on (CP-08), its
 *   actions (CP-12), whether it has a Settings tab.
 * - **Summary** (CP-06; dashboards.md DS-01, DS-04, DS-10, DS-14): the machine's figures and chart cards when Whombat
 *   knows what it runs on, then the kind's or the generic ones, over the page's range (DS-03) — a service's own figures
 *   first and the machine's CPU and Memory after them when its kind says so (service-dashboards.md SD-03, SD-S02); the
 *   kinds come from the registry (`kinds/index.ts`, SD-S01); “Worth a look” as a strip
 *   on top while it has a line (docs/decisions/service-slots.md); the kind's main and side panels, a Proxmox or Unraid
 *   connection's “part of” text when its kind read nothing (else its kind shows the server), “Whombat did
 *   here” and “What Whombat may do” in the main column; “Show more here” at the bottom. A panel with nothing to say is
 *   left out. Every panel says where it sits (`layout`).
 * - **In slots** (docs/decisions/service-slots.md): a kind's page in slots, and the page of a connection without a kind
 *   or whose kind read nothing (`generic.ts`: how it answers), get none of the figures and chart cards above; the
 *   machine is one card after the slots (`slotCard`).
 */

import {
  type CatalogEntry,
  catalogEntry,
  connectionHost,
  isGatewayConnection,
  isVaultSyncConnection,
  parseThingId,
  type ThingLine,
  type ThingPage,
  type ThingPagePanel,
  type ThingPageTab,
  type ThingStatus,
  thingId,
} from '@whombat/core';
import { eq } from 'drizzle-orm';
import { logoOf } from '../connections/look';
import { type ConnectionViewer, isVisibleTo, toolRowsOf } from '../connections/store';
import type { CatalogConnectionRow } from '../connections/types';
import { connectorsOf } from '../connections/views';
import { catalogConnections } from '../db/schema/index';
import { DEVICE_CATALOG_ID, type DeviceSkillRow, skillById, skillOfConnection } from '../devices/store';
import { listChanges } from '../home/changes';
import { notFound } from '../lib/errors';
import { liveResearches } from '../looks/research';
import type { Services } from '../services';
import { type AccountTarget, accountPage, findAccount } from './accounts/index';
import { devicePage, learningPage } from './devices';
import { genericSlots } from './generic';
import { kindFor } from './kinds/index';
import { SERVICE_SETTINGS_TAB_KEY } from './kinds/settings';
import { slotProblems } from './kinds/slots';
import type { KindCtx, KindView } from './kinds/types';
import { diskNotice, itselfCard, type MachineNow, machineCard, machineCharts, machineKpis } from './machine';
import {
  accessItems,
  BADGE,
  connectionStatus,
  genericKpis,
  genericNotices,
  layout,
  offeredRange,
  orderTabs,
  PAGE_REFRESH_S,
  REFRESHING_S,
  rangeFields,
  responseChart,
  SUMMARY_TAB,
} from './panels';
import { displayName, PART_OF, partOfServer, within } from './part-of';
import { DISK_GB_KEY, DISK_PCT_KEY, POINTS_KEEP_MS, RTT_KEY, readPoints } from './points';
import { thingQuiet, thingStates } from './quiet/store';
import type { LooseNotice } from './quiet/types';
import { heldPage, type MarkedLines, markLines } from './quiet/wire';
import {
  hostsServing,
  type MachineFigures,
  machineHref,
  type ResolvedMachine,
  readMachine,
  resolveRunsOn,
} from './runs-on';
import { DEFAULT_RANGE, forecastFull, type PageRange } from './series';
import { clip, dayMonth, line, span } from './words';

/** What the page is about, as the caller may see it. */
export type ThingTarget =
  | { kind: 'connection'; id: string; row: CatalogConnectionRow }
  | { kind: 'device'; id: string; row: CatalogConnectionRow; skill: DeviceSkillRow }
  | { kind: 'learning'; id: string; skill: DeviceSkillRow }
  | { kind: 'account'; id: string; account: AccountTarget };

async function connectionRow(services: Services, id: string): Promise<CatalogConnectionRow | null> {
  const [row] = await services.db.select().from(catalogConnections).where(eq(catalogConnections.id, id));
  return row ?? null;
}

/** The thing behind a thingId for this viewer, or `not_found` (another burrow's is never named). */
export async function findThing(
  services: Services,
  viewer: ConnectionViewer,
  value: string,
): Promise<ThingTarget> {
  const parsed = parseThingId(value);
  if (!parsed || parsed.kind === 'server') throw notFound('Thing');
  const id = thingId(parsed.kind, parsed.id);
  const row = await connectionRow(services, parsed.id);
  if (row) {
    if (!isVisibleTo(row, viewer)) throw notFound('Thing');
    const entry = catalogEntry(row.catalogId);
    if (row.catalogId === DEVICE_CATALOG_ID) {
      const skill = await skillOfConnection(services.db, row.id);
      if (!skill) throw notFound('Thing');
      return { kind: 'device', id, row, skill };
    }
    if (parsed.kind !== 'connection' || !entry || entry.transport === 'builtin') throw notFound('Thing');
    return { kind: 'connection', id, row };
  }
  // The person's accounts: Google, Microsoft 365, Email, GitHub and Website feedback.
  const account = await findAccount(services, viewer, parsed);
  if (account) return { kind: 'account', id, account };
  if (parsed.kind !== 'device') throw notFound('Thing');
  const skill = await skillById(services.db, parsed.id);
  if (!skill || skill.burrowId !== viewer.burrowId) throw notFound('Thing');
  if (skill.status === 'on' && skill.connectionId) {
    const on = await connectionRow(services, skill.connectionId);
    if (on && isVisibleTo(on, viewer)) return { kind: 'device', id, row: on, skill };
  }
  if (skill.status !== 'proposed') throw notFound('Thing');
  return { kind: 'learning', id, skill };
}

/** “Connected by **John** on 8 Oct”, “Connected by **you** on 8 Oct”. */
async function connectedByLine(
  services: Services,
  row: CatalogConnectionRow,
  viewer: ConnectionViewer,
  timeZone: string,
): Promise<ThingLine | null> {
  const on = dayMonth(row.createdAt, timeZone);
  const who = row.connectedById ? (await connectorsOf(services.db, [row])).get(row.connectedById) : undefined;
  if (!who) return line(`Connected on ${on}`);
  const name = who.id === viewer.principal.id ? 'you' : (who.shortName ?? who.name.split(' ')[0] ?? who.name);
  return line(`Connected by **${clip(name, 60)}** on ${on}`);
}

/** “Whombat may **do things** · locks and alarms ask first” (the kind's, else deleting), or “**Look only**”. */
function accessLine(row: CatalogConnectionRow): ThingLine {
  if (row.access === 'read') return line('Whombat may **look only**');
  return line(`Whombat may **do things** · ${kindFor(row)?.asksFirst ?? 'deleting asks first'}`);
}

/** Whether the viewer has changes recorded on this thing (the panel is left out without any). */
async function hasChanges(services: Services, viewer: ConnectionViewer, thing: string, now: Date) {
  const { changes } = await listChanges(services.db, viewer.principal, { limit: 1, thing, now });
  return changes.length > 0;
}

/**
 * The Summary's closing panels (DS-14): “Changes here” (every change, people's own too, HR-05), “What Whombat may do”
 * (main), “Show more here” (bottom).
 */
export function closingPanels(input: {
  changes: boolean;
  access: Extract<ThingPagePanel, { kind: 'access' }> | null;
  suggestions: string[];
}): ThingPagePanel[] {
  const out: ThingPagePanel[] = [];
  if (input.changes)
    out.push({ kind: 'changes', id: 'changes', place: 'main', title: 'Changes here', limit: 5 });
  if (input.access) out.push({ ...input.access, place: 'main' });
  out.push({
    kind: 'widgets',
    id: 'widgets',
    place: 'bottom',
    title: 'Show more here',
    suggestions: input.suggestions.slice(0, 6),
  });
  return out;
}

const GENERIC_SUGGESTIONS = ['Response time', 'How often it’s used'];

/**
 * “Show more here” for a connection without a page of its own: a Custom one first offers what's inside it, which the
 * assistant answers by writing its page.
 */
function genericSuggestions(row: Pick<CatalogConnectionRow, 'catalogId'>): string[] {
  return row.catalogId === 'custom_api' || row.catalogId === 'custom_mcp'
    ? ['What’s inside', ...GENERIC_SUGGESTIONS]
    : GENERIC_SUGGESTIONS;
}

/** A connection's page over `range` (DS-03). */
export async function connectionPage(
  services: Services,
  viewer: ConnectionViewer,
  row: CatalogConnectionRow,
  timeZone: string,
  asked: PageRange = DEFAULT_RANGE,
  /** Gets Worth a look's lines as made, before they are marked (what `things.quiet` finds a line in). */
  linesSink?: (lines: readonly LooseNotice[]) => void,
): Promise<ThingPage> {
  const now = services.clock();
  const entry = catalogEntry(row.catalogId) as CatalogEntry;
  const id = thingId('connection', row.id);
  const kind = kindFor(row);
  const range = offeredRange(asked, kind?.ranges);
  // The kind's read starts now (its page part finds it in the cache) while Whombat finds what it runs on.
  kind?.prefetch?.(services, row, now, timeZone).catch(() => undefined);
  const [resolved, points, quiet] = await Promise.all([
    within(resolveRunsOn(services, viewer.burrowId, row), 5_000, null as ResolvedMachine | null),
    // The response time over the range (at least a day, for Problems) and the disk over 30 days (its forecast).
    readPoints(services.db, row.id, [RTT_KEY, DISK_PCT_KEY, DISK_GB_KEY], now, POINTS_KEEP_MS),
    thingQuiet(services.db, row.burrowId, id),
  ]);
  const figures: MachineFigures | null = resolved
    ? await within(readMachine(services, resolved, range), 5_000, null)
    : null;
  const disk = { pct: points.get(DISK_PCT_KEY) ?? [], gb: points.get(DISK_GB_KEY) ?? [] };
  const ctx: KindCtx = {
    services,
    row,
    entry,
    now,
    timeZone,
    machine: resolved ? { at: resolved, figures } : null,
    range,
    burrowId: viewer.burrowId,
    disk,
    viewer,
    quiet,
  };
  const [view, tools, changed, partOf, connected, states] = await Promise.all([
    kind ? kind.page(ctx) : Promise.resolve(null as KindView | null),
    toolRowsOf(services.db, row.id),
    hasChanges(services, viewer, id, now),
    within(partOfServer(services, viewer.burrowId, row), 5_000, null),
    connectedByLine(services, row, viewer, timeZone),
    thingStates(services.db, id),
  ]);
  // A kind in slots that lays them out wrong still draws; the log says what to fix.
  const misplaced = view?.slots ? slotProblems(view) : [];
  if (misplaced.length)
    services.log.warn({ catalogId: row.catalogId, problems: misplaced }, 'service page: slots out of place');
  const rtt = points.get(RTT_KEY) ?? [];
  // A connection without a kind, and a kind whose read gave nothing to show, get the page's own slots: how it answers.
  // A kind that opens on a tab of its own keeps its Summary to its notices and closing panels: nothing there answers.
  const lead = view?.lead && view.tabs.some((t) => t.key === view.lead) ? view.lead : null;
  const slotted: Pick<KindView, 'panels' | 'slots'> | null = view?.slots
    ? view
    : lead
      ? { panels: view?.panels ?? [] }
      : !view || bareView(view)
        ? genericSlots(row, rtt, now, timeZone)
        : null;
  const problem = view?.problem ?? null;

  // The machine's figures and charts come first (DS-10), unless the kind draws them itself; a kind that puts its own
  // first (SD-03) gets the machine's CPU and Memory after them and no machine chart cards.
  const machine = figures && !view?.ownMachine ? figures : null;
  const after = view?.machine === 'after';
  const full = machine ? forecastFull(disk.pct, 100, now) : null;
  const machineFigures = machine ? machineKpis(machine, full, now) : [];
  const summary: ThingPagePanel[] = [];
  const own = view?.kpis?.length
    ? view.kpis
    : genericKpis(row, rtt, now, timeZone, range, machineFigures.length > 0);
  const kpis = (
    after
      ? [...own, ...machineFigures.filter((k) => k.key === 'cpu' || k.key === 'memory')]
      : [...machineFigures, ...own]
  ).slice(0, 6);
  // A page in slots never gets the generic parts, whatever the view says: no row of figures (its counts are in its own
  // cards), no machine charts (the machine is a card), no response time (it stays in Settings' checks) and no chart
  // cards (a chart over the range goes below the slots).
  if (kpis.length && !slotted) summary.push({ kind: 'kpis', id: 'figures', place: 'top', items: kpis });
  if (!slotted) {
    // A kind with charts of its own, even none, leaves the response time to Settings' checks (SD-03).
    const response = view?.charts ? null : responseChart(rtt, range, now, timeZone);
    summary.push(
      ...(machine && !after ? machineCharts(machine, { now, timeZone }) : []),
      ...(view?.charts ?? []),
      ...(response ? [response] : []),
    );
  }
  const machineDisk = machine
    ? diskNotice(machine, full, {
        now,
        timeZone,
        where: machine.name,
        question: `The disk of ${machine.name} is filling up. What takes the space, and what can go?`,
      })
    : null;
  // Worth a look with what is quiet now, and the head from its active lines (quiet-notices.md QN-14, QN-S13).
  const newTools = tools.filter((t) => t.isNew);
  const kindChecks = new Set((view?.notices ?? []).map((n) => n.check).filter(Boolean));
  const lines: LooseNotice[] = [
    ...(view?.notices ?? []),
    ...(machineDisk && !kindChecks.has(machineDisk.check) ? [machineDisk] : []),
    ...genericNotices(
      row,
      newTools.length,
      problem,
      newTools.map((t) => t.name),
    ),
  ];
  linesSink?.(lines);
  const marked = await markLines(services.db, lines, {
    quiet,
    states,
    now,
    timeZone,
    mayEnd: viewer.principal.kind === 'person',
  });
  // Kept quiet, or down because of something else (monitoring.md MON-04, MON-07).
  const held = heldPage(marked, headStatus(row, view, marked));
  const status = held.head;
  // Worth a look is a strip on top, there only while it has a line (quiet ones too, so Undo stays in reach).
  if (marked.items.length)
    summary.push({
      kind: 'notices',
      id: 'notices',
      place: 'top',
      title: 'Worth a look',
      items: marked.items,
    });
  // A kind in slots shows the server's figures itself (Proxmox VE, Unraid); the sentence is for a page without them.
  if (partOf && !view?.slots) {
    const server = partOf.slice('server:'.length);
    summary.push({
      kind: 'text',
      id: 'part-of',
      place: 'main',
      title: `Part of ${server}`,
      body: `This is how Whombat reaches ${server}’s ${PART_OF[row.catalogId]}. Its figures, machines and backups are on ${server}’s page.`,
      link: { kind: 'href', label: `See ${server}`.slice(0, 30), href: machineHref(server, null) },
    });
  }
  summary.push(...(slotted?.panels ?? view?.panels ?? []));
  const card = slotted?.slots
    ? slotCard(
        slotted.slots,
        machine && resolved ? { figures: machine, at: resolved.runsOn } : null,
        full,
        now,
        displayName(row),
      )
    : null;
  if (card) summary.push(card);
  const items = accessItems(entry, row, tools);
  // A gateway is no agent's (fusebox-page.md), nor is the Vault's sync (onepassword-sync.md): nothing to
  // say about what Whombat may do with it.
  const gateway = isGatewayConnection(entry) || isVaultSyncConnection(entry);
  summary.push(
    ...closingPanels({
      changes: changed,
      access:
        !gateway && (items.length || row.access === 'read')
          ? {
              kind: 'access',
              id: 'access',
              title: 'What Whombat may do',
              items,
              lookOnly: row.access === 'read',
            }
          : null,
      suggestions: view?.suggestions ?? genericSuggestions(row),
    }),
  );
  const settingsTab =
    kind?.settings && view && !bareView(view) && !view.tabs.some((t) => t.key === SERVICE_SETTINGS_TAB_KEY)
      ? await kind.settings.tab(ctx)
      : null;
  const extraTabs = [...(settingsTab ? [settingsTab] : []), ...(view?.tabs ?? [])].slice(0, 7);
  const summaryTab: ThingPageTab = {
    ...SUMMARY_TAB,
    panels: layout(
      summary,
      extraTabs.map((t) => t.key),
    ).slice(0, 24),
  };
  const tabs = orderTabs(summaryTab, extraTabs, lead);

  const facts: ThingLine[] = [...(view?.facts ?? [])];
  if (connected) facts.push(connected);
  const checked = row.glanceAt ?? row.checkedAt;
  if (!view?.facts.length && checked)
    facts.push(line(`Checked **${span(now.getTime() - checked.getTime())}** ago`));
  if (!gateway) facts.push(accessLine(row));
  // The Vault's sync has no address of its own: its row's detail is the vault, which the head's facts name already, and
  // as an address it would ask what the connection runs on.
  const address = isVaultSyncConnection(entry)
    ? undefined
    : (connectionHost(entry, row.fields) ?? row.externalName ?? undefined);
  const readAt = view?.readAt ?? row.glanceAt ?? null;
  return {
    id,
    kind: 'connection',
    connectionId: row.id,
    ...(/^[a-z][a-z0-9_]{1,30}$/.test(row.catalogId) ? { catalogId: row.catalogId } : {}),
    name: clip(displayName(row), 120),
    icon: row.catalogId.slice(0, 40),
    ...(logoOf(row) ? { logo: logoOf(row) } : {}),
    status: status.status,
    badge: status.badge.slice(0, 60),
    facts: facts.slice(0, 6),
    ...(address ? { address: address.slice(0, 200) } : {}),
    ...(view?.open ? { open: view.open } : {}),
    runsOn: resolved?.runsOn ?? null,
    settings: true,
    tabs,
    actions: (view?.actions ?? []).slice(0, 4),
    ...(view?.buttons?.length ? { buttons: view.buttons.slice(0, 4) } : {}),
    ...verdictField(displayName(row), status, view),
    readAt: readAt ? readAt.toISOString() : null,
    ...(problem ? { problem: clip(problem, 200) } : {}),
    ...(partOf ? { partOf } : {}),
    ...rangeFields(range, slotted && !followsRange(tabs[0]?.panels ?? []) ? [range] : kind?.ranges),
    ...(view ? { refreshS: refreshOf(view) } : {}),
    ...held.fields,
  };
}

/**
 * A kind's view with nothing for the Summary (no figures, panels, charts or slots): what a kind gives when its read
 * failed. Its page is then the page of a connection without a kind.
 */
export function bareView(view: Pick<KindView, 'kpis' | 'panels' | 'charts' | 'slots'>): boolean {
  return !view.slots && !view.kpis?.length && !view.panels.length && !view.charts?.length;
}

/**
 * The machine card of a page in slots: the machine Whombat knows it runs on, linked to its page; else the service's own
 * figures as “The machine” (a NAS, Home Assistant OS's Supervisor) without a link; else, with only the kind's lines
 * (its version), “<name> itself”. Null when there is nothing to show.
 */
export function slotCard(
  slots: NonNullable<KindView['slots']>,
  known: { figures: MachineNow; at: { name: string; href?: string } } | null,
  full: Date | null,
  now: Date,
  name: string,
): ThingPagePanel | null {
  if (known) {
    const card = machineCard(
      known.figures,
      { name: known.at.name, href: known.at.href },
      full,
      now,
      slots.machine,
    );
    if (card) return card;
  } else if (slots.own) {
    const card = machineCard(slots.own.figures, { name: slots.own.name }, null, now, slots.machine);
    if (card) return card;
  }
  return itselfCard(name, slots.machine);
}

/**
 * Whether anything on a Summary follows the page's range: a chart over time (a Trend keeps its own days) or a figure's
 * small line. A page in slots without one offers no range picker.
 */
export function followsRange(panels: readonly ThingPagePanel[]): boolean {
  return panels.some(
    (p) => (p.kind === 'chart' && !p.labels) || (p.kind === 'kpis' && p.items.some((k) => k.spark?.length)),
  );
}

/**
 * The sentence under the name (service-settings.md SST-10), for a kind that says one: its own while it is fine, else
 * what needs a look, from the same line as the badge.
 */
export function verdictField(
  name: string,
  status: { status: ThingStatus; badge: string },
  view: Pick<KindView, 'verdict'> | null | undefined,
): { verdict?: string } {
  if (!view?.verdict) return {};
  const what = status.badge.replace(/[.\s]+$/, '');
  const sentence =
    status.status === 'bad'
      ? `${name} has a problem: ${what}.`
      : status.status === 'warn'
        ? `${name} needs a look: ${what}.`
        : status.status === 'ok'
          ? view.verdict
          : null;
  return sentence ? { verdict: clip(sentence, 200) } : {};
}

/**
 * The head's status and badge (QN-02, QN-14; QN-S13): the worst active line that isn't a heads-up says it (its badge,
 * else its title); fine, the kind's own words for fine (“3 of 4 access points online”) or Running fine; never checked
 * and nothing read, Not checked yet. A kind from before quiet notices (no checks on its lines) keeps its own status.
 */
export function headStatus(
  row: Pick<CatalogConnectionRow, 'status' | 'glance'>,
  view: Pick<KindView, 'status' | 'notices' | 'readAt'> | null,
  marked: Pick<MarkedLines, 'status' | 'badge'>,
): { status: ThingStatus; badge: string } {
  const older = view?.status && view.status.status !== 'ok' && !view.notices.some((n) => n.check);
  if (older && view?.status) return view.status;
  if (marked.status !== 'ok') return { status: marked.status, badge: marked.badge ?? BADGE[marked.status] };
  if (view?.status?.status === 'ok') return view.status;
  if (row.glance || view?.readAt) return { status: 'ok', badge: BADGE.ok };
  return connectionStatus(row);
}

/**
 * How often an open page asks again (SD-09): the kind's own (5 s while something moves), else the page's 60; a newer
 * reading on its way makes it the few seconds of PS-02 when that is sooner. Never under 5 nor over an hour (CT-1010).
 */
export function refreshOf(view: Pick<KindView, 'refreshS' | 'refreshing'>): number {
  const own = Math.min(3600, Math.max(REFRESHING_S, Math.round(view.refreshS ?? PAGE_REFRESH_S)));
  return view.refreshing ? Math.min(own, REFRESHING_S) : own;
}

/** `things.page`: the page of a thing the viewer may see, over `range` (a range it doesn't offer: 24 hours). */
export async function thingPage(
  services: Services,
  viewer: ConnectionViewer,
  value: string,
  timeZone: string,
  range: PageRange = DEFAULT_RANGE,
): Promise<ThingPage> {
  const target = await findThing(services, viewer, value);
  if (target.kind === 'connection')
    return withPageResearch(
      services,
      viewer,
      await connectionPage(services, viewer, target.row, timeZone, range),
    );
  if (target.kind === 'device')
    return withPageResearch(services, viewer, await devicePage(services, viewer, target, timeZone, range));
  if (target.kind === 'account')
    return withPageResearch(services, viewer, await accountPage(services, viewer, target.account, timeZone));
  return learningPage(services, target, timeZone);
}

/** A connection's or device's page with what the assistant found out about its look (look-research.md LR-09). */
async function withPageResearch(
  services: Services,
  viewer: ConnectionViewer,
  page: ThingPage,
): Promise<ThingPage> {
  const research = await liveResearches(services.db, viewer.burrowId).catch(() => null);
  const found = research?.get(page.id);
  return found ? { ...page, research: found } : page;
}

/** Whether a person may see a thing (a widget kept on its page, CP-14); servers when this burrow sees them. */
export async function thingVisible(
  services: Services,
  viewer: ConnectionViewer,
  value: string,
): Promise<boolean> {
  const parsed = parseThingId(value);
  if (!parsed) return false;
  if (parsed.kind === 'server') {
    const hosts = await hostsServing(services, viewer.burrowId);
    if (!hosts) return false;
    const fleet = await hosts.fleetRaw().catch(() => null);
    return (
      !!fleet &&
      Array.isArray(fleet.servers) &&
      fleet.servers.some((s) => (s as { id?: unknown }).id === parsed.id)
    );
  }
  try {
    await findThing(services, viewer, value);
    return true;
  } catch {
    return false;
  }
}
