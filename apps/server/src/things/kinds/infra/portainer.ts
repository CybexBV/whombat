/**
 * Portainer's page (service-dashboards.md SD-44): containers running, stopped and unhealthy across its Docker
 * environments, its stacks with how many of their containers run, each environment up or down; one button,
 * **Restart**✱, on a container. Read with the access token: `/api/status`, `/api/system/version`, `/api/endpoints`,
 * `/api/stacks` and each Docker environment's container list through Portainer's Docker proxy (at most 5 environments;
 * Edge environments by their snapshot only). Whether a newer image waits comes from `image_status` where the edition has
 * it (Business; Community 2.45 answers 404 and the figure is left out), at most 12 containers, kept an hour. Never
 * deletes, pulls, prunes or redeploys.
 */
import type {
  ThingGalleryItem,
  ThingLine,
  ThingPageBar,
  ThingPageCell,
  ThingPageItem,
  ThingPageKpi,
  ThingPagePanel,
  ThingPageRow,
} from '@whombat/core';
import type { CatalogConnectionRow } from '../../../connections/types';
import type { Services } from '../../../services';
import { shortHash } from '../../quiet/items';
import type { KindCheck, KindNotice } from '../../quiet/types';
import { clip, line, list, num, plural, rec, str, thousands } from '../../words';
import { actAs } from '../act';
import { type PageButton, pageButton } from '../buttons';
import { cachedRead, getJson } from '../read';
import type { KindAction, KindModule } from '../registry';
import { countLine, inventory, liveRows, slotPanels } from '../slots';
import type { KindCtx, KindView } from '../types';
import {
  type ButtonCtx,
  badgeOf,
  cardOf,
  idOf,
  itemLines,
  linesSeen,
  notOffered,
  okStatus,
  optional,
  readAnswer,
  serviceUrl,
  snapshotReader,
  uniqueById,
  unreadView,
  worstFirst,
} from './shared';

const NAME = 'Portainer';
/** Docker environments whose containers one read lists. */
export const ENVIRONMENTS_MAX = 5;
/** Containers whose image status one read asks for (SD-S05), each kept an hour. */
export const IMAGE_STATUS_MAX = 12;
const IMAGE_STATUS_MS = 60 * 60_000;
/** Containers on the Summary; the Containers tab has them all. */
export const SUMMARY_CONTAINERS = 15;
/** Rows in Live (stacks, or containers without any). */
export const LIVE_ROWS = 10;

const ENV_TYPES: Record<number, string> = {
  1: 'Docker',
  2: 'Docker agent',
  3: 'Azure',
  4: 'Edge agent',
  5: 'Kubernetes',
  6: 'Kubernetes agent',
  7: 'Edge agent',
};
const DOCKER_TYPES = new Set([1, 2]);

export interface PortainerEnv {
  id: number;
  name: string;
  type: string;
  docker: boolean;
  up: boolean;
  /** An Edge agent that hasn't checked in yet: neither up nor down. */
  waiting: boolean;
  /** From Portainer's last snapshot. */
  counts: { running: number; stopped: number; healthy: number; unhealthy: number; total: number } | null;
  /** Images and volumes in its last snapshot; null when it has none. */
  images?: number | null;
  volumes?: number | null;
  /** Its Docker's version, from its last snapshot. */
  dockerVersion?: string | null;
}

export type Health = 'healthy' | 'unhealthy' | 'starting' | null;

export interface PortainerContainer {
  id: string;
  envId: number;
  name: string;
  image: string;
  /** Docker's state: running, exited, restarting, paused, created, dead. */
  state: string;
  /** Docker's own words (“Exited (1) 2 hours ago”). */
  status: string;
  health: Health;
  /** Its Compose project (`com.docker.compose.project`). */
  project: string | null;
  /** The Business edition's word on its image; null when unknown. */
  imageState: 'updated' | 'outdated' | null;
}

export interface PortainerStack {
  id: number | null;
  name: string;
  envId: number;
  /** Portainer's own (1 active, 2 inactive); null for a Compose project Portainer didn't make. */
  active: boolean | null;
}

export interface PortainerSnapshot {
  readAt: Date;
  version: string | null;
  update: string | null;
  envs: PortainerEnv[];
  /** Null when no environment's containers could be listed. */
  containers: PortainerContainer[] | null;
  stacks: PortainerStack[];
  /** This edition answers image status. */
  imageStatus: boolean;
  /** The environments whose containers were listed; absent: every Docker environment that is up. */
  listed?: number[];
  /** Running containers past the first 12 had no image status asked. */
  imagesPartial?: boolean;
  /** Its version (and so whether an update waits) couldn't be read. */
  versionUnread?: boolean;
  /** “CE” or “BE”, and “LTS” or “STS”. */
  edition?: string | null;
  support?: string | null;
}

/** `/api/endpoints`. */
export function parseEnvs(body: unknown): PortainerEnv[] {
  return list(body)
    .slice(0, 100)
    .map((raw): PortainerEnv | null => {
      const e = rec(raw);
      const id = num(e.Id);
      if (id === null) return null;
      const type = num(e.Type) ?? 0;
      const snapshots = list(e.Snapshots);
      const snap = rec(snapshots[0]);
      const running = num(snap.RunningContainerCount);
      const edge = type === 4 || type === 7;
      const waiting = edge && !num(e.LastCheckInDate);
      return {
        id,
        name: clip(str(e.Name) ?? `Environment ${id}`, 80),
        type: ENV_TYPES[type] ?? 'Environment',
        docker: DOCKER_TYPES.has(type),
        // An Edge agent is up while it checks in (`Heartbeat`); the others by Portainer's own status.
        up: edge ? e.Heartbeat === true : num(e.Status) === 1,
        waiting,
        counts:
          running === null
            ? null
            : {
                running,
                stopped: num(snap.StoppedContainerCount) ?? 0,
                healthy: num(snap.HealthyContainerCount) ?? 0,
                unhealthy: num(snap.UnhealthyContainerCount) ?? 0,
                total: num(snap.ContainerCount) ?? running,
              },
        images: snapshots.length ? num(snap.ImageCount) : null,
        volumes: snapshots.length ? num(snap.VolumeCount) : null,
        dockerVersion: str(snap.DockerVersion),
      };
    })
    .filter((e): e is PortainerEnv => e !== null);
}

/** A container's health: Docker 29's `Health.Status`, else the “(unhealthy)” in its status words. */
export function healthOf(c: Record<string, unknown>): Health {
  const h = str(rec(c.Health).Status)?.toLowerCase();
  if (h === 'healthy' || h === 'unhealthy' || h === 'starting') return h;
  const words = (str(c.Status) ?? '').toLowerCase();
  if (words.includes('(unhealthy)')) return 'unhealthy';
  if (words.includes('(healthy)')) return 'healthy';
  if (words.includes('health: starting')) return 'starting';
  return null;
}

/** `/api/endpoints/{id}/docker/containers/json?all=1`. */
export function parseContainers(body: unknown, envId: number): PortainerContainer[] {
  return list(body)
    .slice(0, 500)
    .map((raw): PortainerContainer | null => {
      const c = rec(raw);
      const id = str(c.Id);
      if (!id) return null;
      const name =
        str(list(c.Names).find((n) => typeof n === 'string'))?.replace(/^\//, '') ?? id.slice(0, 12);
      return {
        id: id.slice(0, 80),
        envId,
        name: clip(name, 120),
        image: clip((str(c.Image) ?? '').replace(/@sha256:[0-9a-f]+$/, ''), 120),
        state: (str(c.State) ?? 'unknown').toLowerCase(),
        status: clip(str(c.Status) ?? '', 80),
        health: healthOf(c),
        project: str(rec(c.Labels)['com.docker.compose.project']),
        imageState: null,
      };
    })
    .filter((c): c is PortainerContainer => c !== null);
}

/** `/api/stacks`. */
export function parseStacks(body: unknown): PortainerStack[] {
  return list(body)
    .slice(0, 200)
    .map((raw): PortainerStack | null => {
      const s = rec(raw);
      const name = str(s.Name);
      const envId = num(s.EndpointId);
      if (!name || envId === null) return null;
      return { id: num(s.Id), name: clip(name, 80), envId, active: num(s.Status) === 1 };
    })
    .filter((s): s is PortainerStack => s !== null);
}

/** `image_status`'s word (`{Status: 'updated'|'outdated'|…}`), null for anything else. */
export function imageStatusOf(body: unknown): PortainerContainer['imageState'] {
  const s = str(rec(body).Status)?.toLowerCase();
  return s === 'updated' || s === 'outdated' ? s : null;
}

/** Image status for the first running containers; false when this edition doesn't have it. */
async function readImageStatus(
  services: Services,
  row: CatalogConnectionRow,
  containers: PortainerContainer[],
): Promise<boolean> {
  const asked = containers.filter((c) => c.state === 'running').slice(0, IMAGE_STATUS_MAX);
  let supported = true;
  for (const c of asked) {
    if (!supported) break;
    const got = await cachedRead(
      services,
      `portainer-image:${row.id}:${c.envId}:${c.id}`,
      row,
      async () => {
        const a = await readAnswer(
          services,
          row,
          NAME,
          `/api/docker/${c.envId}/containers/${encodeURIComponent(c.id)}/image_status`,
          { maxBytes: 16 * 1024 },
        );
        return a.status === 404 || a.status === 405 ? 'none' : a.status < 300 ? imageStatusOf(a.json) : null;
      },
      IMAGE_STATUS_MS,
    ).catch(() => null);
    if (got === 'none') supported = false;
    else c.imageState = got;
  }
  return supported && asked.length > 0;
}

export const portainerReader = snapshotReader<PortainerSnapshot>(
  NAME,
  'portainer',
  async (services, row, now) => {
    const get = (path: string, query?: Record<string, string>) => getJson(services, row, NAME, path, query);
    const [status, version, envsDoc, stacksDoc] = await Promise.all([
      optional(get('/api/status')),
      optional(get('/api/system/version')),
      get('/api/endpoints', { excludeSnapshotRaw: 'true' }),
      optional(get('/api/stacks')),
    ]);
    const envs = parseEnvs(envsDoc);
    const lists = await Promise.all(
      envs
        .filter((e) => e.docker && e.up)
        .slice(0, ENVIRONMENTS_MAX)
        .map(async (e) => {
          const doc = await optional(get(`/api/endpoints/${e.id}/docker/containers/json`, { all: '1' }));
          return doc ? { envId: e.id, containers: parseContainers(doc, e.id) } : null;
        }),
    );
    const read = lists.filter((l): l is { envId: number; containers: PortainerContainer[] } => l !== null);
    const containers = read.length ? read.flatMap((l) => l.containers) : null;
    const imageStatus = containers ? await readImageStatus(services, row, containers) : false;
    const v = rec(version);
    return {
      readAt: now,
      version: str(rec(status).Version) ?? str(v.ServerVersion),
      update: v.UpdateAvailable === true ? (str(v.LatestVersion) ?? 'a newer version') : null,
      envs,
      containers,
      stacks: stacksDoc ? parseStacks(stacksDoc) : [],
      imageStatus,
      listed: read.map((l) => l.envId),
      ...(imageStatus && (containers ?? []).filter(isRunning).length > IMAGE_STATUS_MAX
        ? { imagesPartial: true }
        : {}),
      ...(version ? {} : { versionUnread: true }),
      edition: str(v.ServerEdition),
      support: str(v.VersionSupport),
    };
  },
);

/* What it means ------------------------------------------------------------------------------------------------------- */

const isRunning = (c: PortainerContainer) => c.state === 'running' || c.state === 'restarting';
/** Stopped as Portainer counts it: exited or dead (a container only created counts in neither). */
const isStopped = (c: PortainerContainer) => c.state === 'exited' || c.state === 'dead';
const envName = (s: PortainerSnapshot, id: number) =>
  s.envs.find((e) => e.id === id)?.name ?? `Environment ${id}`;

/** Every stack: Portainer's, and Compose projects it didn't make, with their containers. */
export function stacksOf(s: PortainerSnapshot) {
  const out = new Map<string, PortainerStack & { containers: PortainerContainer[] }>();
  for (const st of s.stacks) out.set(`${st.envId}:${st.name}`, { ...st, containers: [] });
  for (const c of s.containers ?? []) {
    if (!c.project) continue;
    const key = `${c.envId}:${c.project}`;
    const st = out.get(key) ?? { id: null, name: c.project, envId: c.envId, active: null, containers: [] };
    st.containers.push(c);
    out.set(key, st);
  }
  return [...out.values()];
}

/** Stopped containers of a stack that otherwise runs. */
function stoppedInRunningStack(s: PortainerSnapshot) {
  return stacksOf(s).flatMap((st) =>
    st.containers.some(isRunning) ? st.containers.filter(isStopped).map((c) => ({ c, stack: st.name })) : [],
  );
}

/** Running, stopped and unhealthy: from the lists, else from the environments' snapshots. */
function counts(s: PortainerSnapshot) {
  if (s.containers)
    return {
      running: s.containers.filter(isRunning).length,
      stopped: s.containers.filter(isStopped).length,
      unhealthy: s.containers.filter((c) => c.health === 'unhealthy').length,
      total: s.containers.length,
    };
  const sum = (k: 'running' | 'stopped' | 'unhealthy' | 'total') =>
    s.envs.reduce((a, e) => a + (e.counts?.[k] ?? 0), 0);
  return {
    running: sum('running'),
    stopped: sum('stopped'),
    unhealthy: sum('unhealthy'),
    total: sum('total'),
  };
}

export function portainerKpis(s: PortainerSnapshot): ThingPageKpi[] {
  const n = counts(s);
  const inStacks = stoppedInRunningStack(s).length;
  const out: ThingPageKpi[] = [
    {
      key: 'running',
      label: 'Running',
      value: String(n.running),
      rest: `of ${n.total}`,
      sub: plural(s.envs.length, 'environment'),
      ...(n.total ? { meter: n.running / n.total } : {}),
      color: 'green',
    },
    {
      key: 'stopped',
      label: 'Stopped',
      value: String(n.stopped),
      sub: inStacks ? `${inStacks} in a running stack` : n.stopped ? 'none in a running stack' : 'none',
      ...(inStacks ? { tone: 'warn' as const } : {}),
    },
    {
      key: 'unhealthy',
      label: 'Unhealthy',
      value: String(n.unhealthy),
      sub: n.unhealthy ? 'failing their health check' : 'all healthy',
      ...(n.unhealthy ? { tone: 'bad' as const } : {}),
    },
  ];
  if (s.imageStatus && s.containers) {
    const outdated = s.containers.filter((c) => c.imageState === 'outdated').length;
    out.push({
      key: 'images',
      label: 'Newer image',
      value: String(outdated),
      sub: outdated ? `${outdated === 1 ? 'container' : 'containers'} can update` : 'all up to date',
    });
  }
  return out;
}

/** Every check Portainer's page can raise (QN-15). */
export const PORTAINER_CHECKS: readonly KindCheck[] = [
  {
    check: 'portainer.env_down',
    name: 'Environments going down',
    nature: 'problem',
    perItem: true,
    startsOn: true,
  },
  {
    check: 'portainer.unhealthy',
    name: 'Unhealthy containers',
    nature: 'problem',
    perItem: true,
    startsOn: true,
  },
  {
    check: 'portainer.stopped',
    name: 'Containers stopping in a stack',
    nature: 'problem',
    perItem: true,
    startsOn: true,
  },
  { check: 'portainer.images', name: 'Newer images', nature: 'fyi', perItem: false, startsOn: false },
  { check: 'portainer.updates', name: 'Portainer updates', nature: 'fyi', perItem: false, startsOn: false },
];

/** Docker environments that are up but whose containers weren't listed (past the first five, or refused). */
const unlisted = (s: PortainerSnapshot) =>
  s.envs.filter((e) => e.up && (s.listed ? !s.listed.includes(e.id) : !s.containers || !e.docker));

/** What this read couldn't see (QN-11): containers of a Docker environment not listed, images not asked, the version. */
export function portainerSkipped(s: PortainerSnapshot): string[] {
  const out: string[] = [];
  if (!s.containers || unlisted(s).some((e) => e.docker))
    out.push('portainer.unhealthy', 'portainer.stopped', 'portainer.images');
  if (s.imagesPartial) out.push('portainer.images');
  if (s.versionUnread) out.push('portainer.updates');
  return out;
}

/**
 * A container by its environment and name (QN-S3x): Docker's id changes each time it's made again (Compose up, a
 * new image), its name doesn't.
 */
const containerSubject = (c: PortainerContainer) => ({
  id: clip(`container:${c.envId}/${c.name}`, 160),
  name: clip(c.name, 80),
});

/** Exit codes of a container stopped on purpose (QN-04): done (0), or stopped by Docker's stop (137, 143). */
const ON_PURPOSE = new Set(['0', '137', '143']);

const moreLine =
  (id: string, what: (n: number) => string, link?: KindNotice['link']) => (rest: readonly KindNotice[]) => ({
    id,
    title: what(rest.length),
    detail: clip(rest.map((n) => n.subject?.name ?? n.title).join(' · '), 200),
    ...(link ? { link } : {}),
  });

/** Worth a look (SD-44; quiet-notices.md QN-01…QN-04): one line per environment and container. */
export function portainerNotices(s: PortainerSnapshot, url: string, ctx?: ButtonCtx): KindNotice[] {
  const out: KindNotice[] = [];
  const down = s.envs
    .filter((x) => !x.up && !x.waiting)
    .map(
      (e): KindNotice => ({
        id: `env-down-${e.id}`,
        tone: 'bad',
        icon: 'network',
        title: clip(`Environment ${e.name} is down`, 120),
        detail: 'Portainer can’t reach its Docker; its containers may be down too.',
        link: {
          kind: 'ask',
          label: 'Look into it',
          question: clip(`Why can’t Portainer reach the environment ${e.name}?`, 300),
        },
        nature: 'problem',
        check: 'portainer.env_down',
        subject: { id: `env:${e.id}`, name: e.name },
        ignore: { lifts: 'fixed', words: 'Until it’s back up.' },
        badge: badgeOf(`${e.name} is down`),
      }),
    );
  out.push(
    ...itemLines(
      down,
      moreLine('env-down-more', (n) => `${plural(n, 'more environment is', 'more environments are')} down`),
    ),
  );
  const sick = (s.containers ?? [])
    .filter((c) => c.health === 'unhealthy')
    .map(
      (c): KindNotice => ({
        id: idOf('unhealthy', `${c.envId}-${c.id.slice(0, 12)}`),
        tone: 'bad',
        icon: 'warn',
        title: clip(`${c.name} is unhealthy`, 120),
        detail: clip(
          `It fails its health check${s.envs.length > 1 ? ` on ${envName(s, c.envId)}` : ''}.`,
          200,
        ),
        link: {
          kind: 'ask',
          label: 'Look into it',
          question: clip(`Why is the container ${c.name} unhealthy?`, 300),
        },
        ...(ctx ? { action: restartButton(ctx, c) } : {}),
        nature: 'problem',
        check: 'portainer.unhealthy',
        subject: containerSubject(c),
        ignore: { lifts: 'fixed', words: 'Until it’s healthy again.' },
        badge: badgeOf(`${c.name} unhealthy`),
      }),
    );
  // Environments whose containers weren't listed (Edge agents, past the first five): their snapshot's count.
  for (const e of unlisted(s)) {
    const n = e.counts?.unhealthy ?? 0;
    if (n)
      sick.push({
        id: `unhealthy-env-${e.id}`,
        tone: 'bad',
        icon: 'warn',
        title: clip(`${plural(n, 'container')} unhealthy on ${e.name}`, 120),
        link: { kind: 'url', label: 'Open Portainer', url },
        nature: 'problem',
        check: 'portainer.unhealthy',
        subject: { id: `env:${e.id}`, name: e.name },
        // More of them is worse: the Ignore ends (QN-11).
        band: n,
        ignore: { lifts: 'fixed', words: 'Until they’re healthy again.' },
        badge: badgeOf(`${n} unhealthy`),
      });
  }
  out.push(
    ...itemLines(
      sick,
      moreLine(
        'unhealthy-more',
        (n) => `${plural(n, 'more container is', 'more containers are')} unhealthy`,
        { kind: 'url', label: 'Open Portainer', url },
      ),
    ),
  );
  const stopped = stoppedInRunningStack(s).map(({ c, stack }): KindNotice => {
    const code = /^Exited \((\d+)\)/.exec(c.status)?.[1];
    // Done (0) or stopped with `docker stop` (137, 143): on purpose, a heads-up (QN-04).
    const fine = c.state !== 'dead' && code !== undefined && ON_PURPOSE.has(code);
    return {
      id: idOf('stopped', `${c.envId}-${c.id.slice(0, 12)}`),
      tone: fine ? 'info' : 'warn',
      icon: 'power',
      title: clip(`${c.name} has stopped in ${stack}`, 120),
      detail:
        code && code !== '0' && !fine
          ? `It exited with an error (code ${code}).`
          : code === '0'
            ? 'It finished its work; the rest of its stack runs.'
            : 'The rest of its stack runs.',
      ...(fine
        ? {}
        : {
            link: {
              kind: 'ask' as const,
              label: 'Look into it',
              question: clip(`Why did the container ${c.name} stop in ${stack}?`, 300),
            },
            badge: badgeOf(`${c.name} stopped`),
          }),
      nature: fine ? 'fyi' : 'problem',
      check: 'portainer.stopped',
      subject: containerSubject(c),
      ignore: { lifts: 'fixed', words: 'Until it’s running again.' },
    };
  });
  out.push(
    ...itemLines(
      worstFirst(stopped),
      moreLine(
        'stopped-more',
        (n) => `${plural(n, 'more container has', 'more containers have')} stopped in a stack`,
      ),
    ),
  );
  if (s.imageStatus) {
    const outdated = (s.containers ?? []).filter((c) => c.imageState === 'outdated');
    if (outdated.length)
      out.push({
        id: 'images',
        tone: 'info',
        icon: 'update',
        title: `${plural(outdated.length, 'container')} ${outdated.length === 1 ? 'has' : 'have'} a newer image`,
        detail: clip(outdated.map((c) => c.name).join(' · '), 200),
        nature: 'fyi',
        check: 'portainer.images',
        episode: shortHash(outdated.map((c) => containerSubject(c).id)),
        ignore: { lifts: 'newer', words: 'Until another container has a newer image.' },
      });
  }
  if (s.update)
    out.push({
      id: 'update',
      tone: 'info',
      icon: 'update',
      title: 'Portainer has an update',
      detail: clip(`Version ${s.update}.`, 200),
      nature: 'fyi',
      check: 'portainer.updates',
      episode: s.update,
      ignore: { lifts: 'newer', words: 'Until a newer version is out.' },
    });
  return uniqueById(out);
}

/** The head when nothing is worth a look (QN-S30): how many run; the lines say what's wrong. */
export function portainerStatus(s: PortainerSnapshot): NonNullable<KindView['status']> {
  return okStatus(`${counts(s).running} running`);
}

const STATE_WORDS: Record<string, { text: string; dot: NonNullable<ThingPageCell['dot']> }> = {
  running: { text: 'Running', dot: 'ok' },
  restarting: { text: 'Restarting', dot: 'warn' },
  paused: { text: 'Paused', dot: 'warn' },
  created: { text: 'Created', dot: 'off' },
  exited: { text: 'Stopped', dot: 'off' },
  dead: { text: 'Dead', dot: 'bad' },
  removing: { text: 'Being removed', dot: 'warn' },
};

const HEALTH_WORDS: Record<NonNullable<Health>, ThingPageCell> = {
  healthy: { text: 'Healthy', tone: 'ok' },
  unhealthy: { text: 'Unhealthy', tone: 'bad' },
  starting: { text: 'Starting', tone: 'muted' },
};

/** Restart✱ on a container (SD-44). */
export function restartButton(ctx: ButtonCtx, c: PortainerContainer): PageButton {
  return pageButton(ctx, {
    action: 'restart',
    target: `${c.envId}:${c.id}`,
    label: 'Restart',
    icon: 'restart',
    confirm: {
      title: clip(`Restart ${c.name}?`, 80),
      body: 'It stops and starts again; what it serves is away for a moment.',
      button: 'Restart',
    },
  });
}

export function containerRows(s: PortainerSnapshot, ctx: ButtonCtx): ThingPageRow[] {
  const inStack = new Set(stoppedInRunningStack(s).map((x) => x.c.id));
  const rank = (c: PortainerContainer) =>
    c.health === 'unhealthy'
      ? 0
      : inStack.has(c.id)
        ? 1
        : c.state === 'dead' || c.state === 'restarting'
          ? 2
          : isRunning(c)
            ? 3
            : 4;
  const many = s.envs.length > 1;
  return [...(s.containers ?? [])]
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    .slice(0, 300)
    .map((c) => {
      const state = STATE_WORDS[c.state] ?? { text: c.state, dot: 'off' as const };
      return {
        id: `${c.envId}:${c.id}`.slice(0, 200),
        cells: {
          name: {
            text: c.name,
            ...(many ? { note: clip(envName(s, c.envId), 80) } : c.project ? { note: c.project } : {}),
          },
          state: {
            ...state,
            ...(c.state === 'exited' && /^Exited \((?!0\))/.test(c.status)
              ? { text: 'Stopped with an error', dot: 'bad' as const }
              : {}),
          },
          health: c.health ? HEALTH_WORDS[c.health] : { text: '—', tone: 'muted' },
          image: {
            text: c.image,
            mono: true,
            ...(c.imageState === 'outdated' ? { note: 'newer image', tone: 'warn' as const } : {}),
          },
          ...(c.state !== 'dead' && c.state !== 'removing'
            ? { restart: { text: 'Restart', action: restartButton(ctx, c) } }
            : {}),
        },
      };
    });
}

const CONTAINER_COLUMNS = [
  { key: 'name', label: 'Container' },
  { key: 'state', label: 'State' },
  { key: 'health', label: 'Health' },
  { key: 'image', label: 'Image' },
  { key: 'restart', label: '' },
];

export function envItems(s: PortainerSnapshot): ThingPageItem[] {
  return s.envs.slice(0, 50).map((e) => ({
    id: `env-${e.id}`,
    title: e.name,
    detail: e.counts ? `${e.type} · ${e.counts.running} running · ${e.counts.stopped} stopped` : e.type,
    right: e.up ? 'Up' : e.waiting ? 'Not checked in yet' : 'Down',
    tone: e.up ? ('ok' as const) : e.waiting ? ('info' as const) : ('bad' as const),
    icon: 'network' as const,
  }));
}

export function portainerFacts(s: PortainerSnapshot): ThingLine[] {
  const facts: ThingLine[] = [];
  if (s.version) facts.push(line(`Portainer **${s.version}**`));
  const stacks = stacksOf(s).length;
  facts.push(
    line(`**${plural(s.envs.length, 'environment')}**${stacks ? ` · **${plural(stacks, 'stack')}**` : ''}`),
  );
  return facts;
}

/** A stack's or a group's containers as a live row: how many run as its bar, what's wrong as its tag. */
function stackRow(
  id: string,
  title: string,
  sub: string | null,
  containers: readonly PortainerContainer[],
  stopped: boolean | null,
): ThingGalleryItem {
  const all = containers.length;
  const running = containers.filter(isRunning).length;
  const sick = containers.filter((c) => c.health === 'unhealthy').length;
  const down = containers.filter(isStopped).length;
  const badge = sick
    ? { text: sick === 1 ? 'Unhealthy' : `${sick} unhealthy`, tone: 'bad' as const }
    : all && !running
      ? { text: 'Stopped', tone: 'warn' as const }
      : down
        ? { text: `${down} stopped`, tone: 'warn' as const }
        : !all && stopped
          ? { text: 'Stopped', tone: 'warn' as const }
          : null;
  // A stack that is off on purpose stands still: its bar and tag are grey.
  const still = (all > 0 && !running) || (!all && stopped === true);
  return {
    id: id.slice(0, 200),
    title: clip(title, 120),
    ...(sub ? { sub: clip(sub, 120) } : {}),
    ...(badge ? { badge } : {}),
    ...(all ? { progress: running / all, note: `${running} of ${all} running` } : {}),
    ...(still ? { paused: true } : {}),
  };
}

/** How bad a stack looks: unhealthy first, then one with stopped containers, then a stopped one, then the rest. */
function stackRank(containers: readonly PortainerContainer[]): number {
  if (containers.some((c) => c.health === 'unhealthy')) return 0;
  const running = containers.some(isRunning);
  if (running && containers.some(isStopped)) return 1;
  if (containers.length && !running) return 2;
  return 3;
}

/** A container's state as its row's tag; null while it simply runs. */
function containerBadge(c: PortainerContainer): ThingGalleryItem['badge'] | null {
  if (c.health === 'unhealthy') return { text: 'Unhealthy', tone: 'bad' };
  if (c.state === 'dead') return { text: 'Dead', tone: 'bad' };
  if (c.state === 'exited' && /^Exited \((?!0\))/.test(c.status))
    return { text: 'Stopped with an error', tone: 'bad' };
  if (c.state === 'running') return null;
  const words = STATE_WORDS[c.state]?.text ?? c.state;
  return { text: clip(words, 30), tone: 'warn' };
}

/**
 * Stacks now (Live): each stack with how many of its containers run, the worst first, and the containers outside any
 * stack as one last row. Without stacks: Containers now, each container with Restart✱.
 */
export function portainerLive(s: PortainerSnapshot, ctx: ButtonCtx) {
  if (!s.containers) return null;
  const many = s.envs.length > 1;
  const n = counts(s);
  const stacks = stacksOf(s);
  if (stacks.length) {
    const sorted = [...stacks].sort(
      (a, b) => stackRank(a.containers) - stackRank(b.containers) || a.name.localeCompare(b.name),
    );
    const items = sorted
      .slice(0, LIVE_ROWS)
      .map((st) =>
        stackRow(
          `stack-${st.envId}-${st.name}`,
          st.name,
          [many ? envName(s, st.envId) : null, plural(st.containers.length, 'container')]
            .filter(Boolean)
            .join(' · '),
          st.containers,
          st.active === false,
        ),
      );
    const loose = s.containers.filter((c) => !c.project);
    if (loose.length && items.length < LIVE_ROWS)
      items.push(stackRow('other', 'Other containers', 'Not in a stack', loose, null));
    return liveRows({
      id: 'stacks',
      title: 'Stacks now',
      shape: 'square',
      meta: `${plural(stacks.length, 'stack')} · ${n.running} of ${n.total} containers run`,
      ...(stacks.length > LIVE_ROWS
        ? { link: { kind: 'tab' as const, label: 'All containers', tab: 'containers' } }
        : {}),
      items,
      empty: 'No stacks yet.',
    });
  }
  const rows = containerRows(s, ctx);
  const byKey = new Map(s.containers.map((c) => [`${c.envId}:${c.id}`, c]));
  // What went wrong first (unhealthy, dead, stopped with an error), then what runs, then what is simply off.
  const rank = (id: string) => {
    const c = byKey.get(id);
    const tone = c ? containerBadge(c)?.tone : undefined;
    return tone === 'bad' ? 0 : c && isRunning(c) ? 1 : 2;
  };
  const sorted = rows.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r.id) - rank(b.r.id) || a.i - b.i);
  const items = sorted.slice(0, LIVE_ROWS).flatMap(({ r }): ThingGalleryItem[] => {
    const c = byKey.get(r.id);
    if (!c) return [];
    const badge = containerBadge(c);
    const restart = r.cells.restart?.action;
    // Docker's own words without the health already in the tag: “Up 2 hours”.
    const since = c.status.replace(/\s*\((?:un)?healthy\)|\s*\(health: starting\)/i, '').trim();
    return [
      {
        id: `container-${r.id}`.slice(0, 200),
        title: clip(c.name, 120),
        sub: clip([many ? envName(s, c.envId) : null, c.image].filter(Boolean).join(' · '), 120),
        ...(badge ? { badge } : {}),
        ...(badge && !isRunning(c) && badge.tone === 'warn' ? { paused: true } : {}),
        ...(since ? { noteEnd: clip(since, 60) } : {}),
        ...(restart ? { actions: [restart] } : {}),
      },
    ];
  });
  return liveRows({
    id: 'now',
    title: 'Containers now',
    shape: 'square',
    meta: `${n.running} of ${n.total} running`,
    ...(rows.length > LIVE_ROWS
      ? { link: { kind: 'tab' as const, label: `All ${rows.length} containers`, tab: 'containers' } }
      : {}),
    items,
    empty: 'No containers yet.',
  });
}

/** A sum of the environments' snapshot figures; null when none has one. */
function snapshotSum(s: PortainerSnapshot, key: 'images' | 'volumes'): number | null {
  const known = s.envs.map((e) => e[key]).filter((v): v is number => typeof v === 'number');
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}

/** In Portainer (Inventory): its containers, images, volumes and environments, each opening Portainer. */
export function portainerInventory(s: PortainerSnapshot, url: string) {
  const n = counts(s);
  const lines: ThingPageItem[] = [
    countLine({
      id: 'containers',
      title: 'Containers',
      icon: 'device',
      value: thousands(n.total),
      detail: `${n.running} running`,
      ...(n.unhealthy
        ? { note: `${n.unhealthy} unhealthy`, noteTone: 'bad' as const }
        : n.stopped
          ? { note: `${n.stopped} stopped` }
          : n.total
            ? { note: 'All running', noteTone: 'ok' as const }
            : {}),
      url,
    }),
  ];
  const images = snapshotSum(s, 'images');
  if (images !== null) {
    const outdated = s.imageStatus
      ? (s.containers ?? []).filter((c) => c.imageState === 'outdated').length
      : 0;
    lines.push(
      countLine({
        id: 'images',
        title: 'Images',
        icon: 'disk',
        value: thousands(images),
        ...(outdated ? { note: `${outdated} can update` } : {}),
        url,
      }),
    );
  }
  const volumes = snapshotSum(s, 'volumes');
  if (volumes !== null)
    lines.push(
      countLine({ id: 'volumes', title: 'Volumes', icon: 'database', value: thousands(volumes), url }),
    );
  const down = s.envs.filter((e) => !e.up && !e.waiting).length;
  const waiting = s.envs.filter((e) => e.waiting).length;
  lines.push(
    countLine({
      id: 'environments',
      title: 'Environments',
      icon: 'network',
      value: thousands(s.envs.length),
      ...(down
        ? { note: `${down} down`, noteTone: 'bad' as const }
        : waiting
          ? { note: `${waiting} not checked in yet` }
          : s.envs.length
            ? { note: 'All up', noteTone: 'ok' as const }
            : {}),
      url,
    }),
  );
  return inventory({ id: 'inventory', title: 'In Portainer', items: lines });
}

/** Its own lines in the machine card: its version with its edition and whether an update waits, and its Docker. */
export function portainerMachineLines(s: PortainerSnapshot): ThingPageBar[] {
  const out: ThingPageBar[] = [];
  if (s.version) {
    const note = [s.edition, s.support].filter(Boolean).join(' · ');
    out.push({
      id: 'portainer-version',
      label: 'Portainer',
      ...(note ? { note: clip(note, 80) } : {}),
      value: clip(s.version, 40),
      pct: null,
      ...(s.update
        ? { sub: clip(`Version ${s.update} is out`, 120) }
        : s.versionUnread
          ? {}
          : { sub: 'Up to date', subTone: 'ok' as const }),
    });
  }
  // Its Docker, when it manages one: then it most likely runs beside it.
  const docker = s.envs.filter((e) => e.docker);
  const only = docker.length === 1 ? docker[0]?.dockerVersion : null;
  if (only) out.push({ id: 'docker-version', label: 'Docker', value: clip(only, 40), pct: null });
  return out;
}

/** Below the slots: the containers (beside stacks) and the environments when there are several. */
function portainerMore(s: PortainerSnapshot, rows: ThingPageRow[], stacks: boolean): ThingPagePanel[] {
  const out: ThingPagePanel[] = [];
  // Without stacks Live already lists the containers: the table is in its tab.
  if (s.containers && stacks)
    out.push({
      kind: 'table',
      id: 'containers',
      place: 'main',
      title: 'Containers',
      meta: plural(s.containers.length, 'container'),
      ...(rows.length > SUMMARY_CONTAINERS
        ? { link: { kind: 'tab' as const, label: 'All containers', tab: 'containers' } }
        : {}),
      columns: CONTAINER_COLUMNS,
      rows: rows.slice(0, SUMMARY_CONTAINERS),
      empty: 'No containers yet.',
    });
  if (s.envs.length > 1)
    out.push({
      kind: 'list',
      id: 'environments',
      place: 'main',
      title: 'Environments',
      items: envItems(s),
    });
  return out;
}

/**
 * The Summary in slots (docs/decisions/service-slots.md): its stacks now beside what it holds; no Trend (Docker keeps
 * no history Portainer shows), no Shelf, no People. The containers below the stacks, every container in its tab.
 */
export function portainerSlots(
  s: PortainerSnapshot,
  url: string,
  ctx: ButtonCtx,
  rows = containerRows(s, ctx),
): Pick<KindView, 'panels' | 'slots'> {
  const stacks = stacksOf(s).length > 0;
  return slotPanels({
    live: portainerLive(s, ctx),
    inventory: portainerInventory(s, url),
    more: portainerMore(s, rows, stacks),
    machine: portainerMachineLines(s),
  });
}

export interface PortainerInput {
  snapshot: PortainerSnapshot;
  url: string;
  row: ButtonCtx['row'];
}

/** The page's Portainer part (SD-44), in slots; pure. */
export function portainerView({ snapshot: s, url, row }: PortainerInput): KindView {
  const rows = containerRows(s, { row });
  // Every container in its tab: past the Summary's 15 beside stacks, and always without stacks (Live shows the first).
  const tab = rows.length > (stacksOf(s).length ? SUMMARY_CONTAINERS : 0);
  return {
    // In slots its counts are in Live and In Portainer; the card keeps its figures (`portainerKpis` in `seen`).
    kpis: [],
    machine: 'after',
    charts: [],
    notices: portainerNotices(s, url, { row }),
    ...portainerSlots(s, url, { row }, rows),
    tabs: tab
      ? [
          {
            key: 'containers',
            label: 'Containers',
            count: rows.length,
            panels: [
              {
                kind: 'table',
                id: 'containers',
                title: 'Containers',
                meta: plural(rows.length, 'container'),
                columns: CONTAINER_COLUMNS,
                rows,
              },
            ],
          },
        ]
      : [],
    facts: portainerFacts(s),
    status: portainerStatus(s),
    open: { label: 'Open Portainer', url },
    actions: [],
    readAt: s.readAt,
    suggestions: ['A container’s last log lines', 'Memory per container', 'Images to update'],
  };
}

export async function portainerPage(ctx: KindCtx): Promise<KindView> {
  const url = serviceUrl(ctx.row);
  const read = await portainerReader.latest(ctx.services, ctx.row, ctx.now);
  if (!read.ok) return unreadView(read, NAME, { label: 'Open Portainer', url }, []);
  return {
    ...portainerView({ snapshot: read.value, url, row: ctx.row }),
    refreshing: read.refreshing,
  };
}

/** Restart one container the last read listed (SD-44 ✱). */
const restart: KindAction = async ({ services, row, now }, { target }) => {
  const s = await portainerReader.cached(services, row, now);
  const c = (s.containers ?? []).find((x) => `${x.envId}:${x.id}` === target);
  if (!c) throw notOffered('That container');
  await actAs(services, row, NAME, {
    method: 'POST',
    path: `/api/endpoints/${c.envId}/docker/containers/${encodeURIComponent(c.id)}/restart`,
    deadlineMs: 30_000,
  });
  return { message: `Restarted ${c.name}.`, title: clip(`Restarted ${c.name}`, 200) };
};

export const PORTAINER_KIND: KindModule = {
  page: portainerPage,
  seen: async (services, row, now) => {
    const s = await portainerReader.cached(services, row, now);
    const view = portainerView({ snapshot: s, url: serviceUrl(row), row });
    return {
      // The page has no row of figures; the card keeps Running and Unhealthy.
      glance: cardOf(
        { kpis: portainerKpis(s), notices: view.notices },
        ['running', 'unhealthy'],
        plural(counts(s).total, 'container'),
      ),
      points: {},
      ...linesSeen(view, portainerSkipped(s)),
    };
  },
  checks: PORTAINER_CHECKS,
  actions: { restart },
};
