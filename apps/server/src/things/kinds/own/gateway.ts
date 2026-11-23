/**
 * An AI gateway's page (the generic one: LiteLLM, a company's gateway): what Whombat sends through it, from its own
 * turns, and which models it offers. A gateway has no management API Whombat knows, so the turns are Whombat's records:
 * each turn keeps the provider it went through the gateway for while its switch was on, and a burrow has at most one
 * gateway. The models are the gateway's own list, the same read as its check, kept 15 minutes.
 */
import type { ThingPageItem } from '@whombat/core';
import { and, eq, gte, inArray, isNotNull } from 'drizzle-orm';
import type { CatalogConnectionRow } from '../../../connections/types';
import { burrows, dispatches } from '../../../db/schema/index';
import { switchesOf } from '../../../gateway/store';
import type { Services } from '../../../services';
import { displayName } from '../../part-of';
import { clip, plural } from '../../words';
import { cachedRead, getJson } from '../read';
import type { KindModule, KindSeen } from '../registry';
import { countByDay, countLine, inventory, lastDays, slotPanels, trend, weekChange } from '../slots';
import type { KindView } from '../types';

const DAY = 86_400_000;
const TURNS_KEEP_MS = 60_000;
const MODELS_KEEP_MS = 15 * 60_000;

export interface GatewayTurn {
  provider: 'claude' | 'codex';
  failed: boolean;
  at: Date;
}

export interface GatewaySnapshot {
  switches: { claude: boolean; codex: boolean };
  /** Finished turns through the gateway over the last 14 days. */
  turns: GatewayTurn[];
  /** Turns going through it now. */
  running: number;
  /** The gateway's models, or null when its list couldn't be read. */
  models: string[] | null;
}

/** The model ids of an OpenAI-style list (`{ data: [{ id }] }`), LiteLLM's too. */
export function modelIds(json: unknown): string[] | null {
  const data = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  return data
    .map((m) => (m as { id?: unknown } | null)?.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

export async function turnsLoad(services: Services, row: CatalogConnectionRow, now: Date) {
  const since = new Date(Math.max(now.getTime() - 14 * DAY, row.createdAt.getTime()));
  const [finished, running, [burrow]] = await Promise.all([
    services.db
      .select({ provider: dispatches.gatewayProvider, state: dispatches.state, at: dispatches.finishedAt })
      .from(dispatches)
      .where(
        and(
          eq(dispatches.burrowId, row.burrowId),
          gte(dispatches.finishedAt, since),
          isNotNull(dispatches.gatewayProvider),
        ),
      ),
    services.db
      .select({ id: dispatches.id })
      .from(dispatches)
      .where(
        and(
          eq(dispatches.burrowId, row.burrowId),
          inArray(dispatches.state, ['claimed', 'running']),
          isNotNull(dispatches.gatewayProvider),
        ),
      ),
    services.db.select({ aiGateway: burrows.aiGateway }).from(burrows).where(eq(burrows.id, row.burrowId)),
  ]);
  return {
    switches: switchesOf(burrow?.aiGateway ?? null, row.id),
    turns: finished
      .filter((t) => t.at && t.provider)
      .map((t) => ({
        provider: t.provider as GatewayTurn['provider'],
        failed: t.state === 'failed',
        at: t.at as Date,
      })),
    running: running.length,
  };
}

async function snapshot(services: Services, row: CatalogConnectionRow, now: Date): Promise<GatewaySnapshot> {
  const [own, models] = await Promise.all([
    cachedRead(services, `gateway-turns:${row.id}`, row, () => turnsLoad(services, row, now), TURNS_KEEP_MS),
    cachedRead(
      services,
      `gateway-models:${row.id}`,
      row,
      async () => modelIds(await getJson(services, row, displayName(row), '/v1/models')),
      MODELS_KEEP_MS,
    ).catch(() => null),
  ]);
  return { ...own, models };
}

const onOff = (on: boolean) => (on ? 'On' : 'Off');

/** The page from what Whombat keeps and the gateway's list (pure). */
export function gatewayView(s: GatewaySnapshot, now: Date, timeZone: string): KindView {
  const t = now.getTime();
  const week = s.turns.filter((x) => x.at.getTime() > t - 7 * DAY);
  const before = s.turns.filter((x) => x.at.getTime() > t - 14 * DAY && x.at.getTime() <= t - 7 * DAY);
  const today = s.turns.filter((x) => x.at.getTime() > t - DAY);
  const failedToday = today.filter((x) => x.failed).length;

  const items: ThingPageItem[] = [
    countLine({
      id: 'claude',
      title: 'Claude Code',
      icon: 'network',
      detail: 'Goes through it',
      value: onOff(s.switches.claude),
      ...(s.switches.claude ? { noteTone: 'ok' as const, note: 'Switched on' } : {}),
    }),
    countLine({
      id: 'codex',
      title: 'ChatGPT',
      icon: 'network',
      detail: 'Goes through it',
      value: onOff(s.switches.codex),
      ...(s.switches.codex ? { noteTone: 'ok' as const, note: 'Switched on' } : {}),
    }),
    countLine({
      id: 'turns',
      title: 'Turns today',
      icon: 'clock',
      ...(s.running ? { detail: `${s.running} going now` } : {}),
      value: String(today.length),
      ...(failedToday ? { note: `${failedToday} failed`, noteTone: 'warn' as const } : {}),
    }),
    ...(s.models
      ? [
          countLine({
            id: 'models',
            title: 'Models',
            icon: 'database',
            ...(s.models.length ? { detail: clip(s.models.slice(0, 3).join(', '), 300) } : {}),
            value: String(s.models.length),
          }),
        ]
      : []),
  ];
  const counts = inventory({ id: 'through', title: 'Through the gateway', items });

  const days = lastDays(now, timeZone);
  const perDay = countByDay(
    week.map((x) => x.at),
    days.keys,
    timeZone,
  );
  const turns =
    week.length || before.length
      ? trend({
          id: 'week',
          title: 'Turns',
          meta: 'Per day',
          days,
          values: perDay,
          label: 'Turns',
          figure: { value: String(week.length), rest: 'this week' },
          change: weekChange(week.length, before.length),
          color: 'blue',
        })
      : undefined;

  const on = s.switches.claude || s.switches.codex;
  return {
    ...slotPanels({ inventory: counts, trend: turns }),
    kpis: [],
    notices: [],
    tabs: [],
    facts: [],
    actions: [],
    readAt: now,
    suggestions: ['Turns per week', 'Failed turns'],
    verdict: on
      ? `${plural(week.length, 'turn')} went through it this week.`
      : 'Nothing goes through it now: both switches are off.',
  };
}

/** The card: turns today, and whether anything goes through it. */
export function gatewaySeen(s: GatewaySnapshot, now: Date): KindSeen {
  const today = s.turns.filter((x) => x.at.getTime() > now.getTime() - DAY).length;
  return {
    glance: {
      facts: [{ label: 'Turns today', value: String(today) }],
      line: s.switches.claude || s.switches.codex ? `${plural(today, 'turn')} today` : 'Switched off',
    },
    points: {},
    notices: [],
  };
}

export const AI_GATEWAY_KIND: KindModule = {
  page: async ({ services, row, now, timeZone }) =>
    gatewayView(await snapshot(services, row, now), now, timeZone),
  seen: async (services, row, now) => {
    // The health pass never reads the gateway's list: its check does that already.
    const own = await cachedRead(
      services,
      `gateway-turns:${row.id}`,
      row,
      () => turnsLoad(services, row, now),
      TURNS_KEEP_MS,
    );
    return gatewaySeen({ ...own, models: null }, now);
  },
  checks: [],
};
