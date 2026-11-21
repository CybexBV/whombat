/**
 * The backup app as a compose file (docs/decisions/backup-places.md BPL-01, BPL-02, BPL-09): what a Synology project, a
 * TrueNAS custom app and a QNAP Container Station application run, and what a person pastes when Whombat can't install
 * it.
 *
 * - `server`: restic's REST server that only adds and keeps one user to its own folder. The image has no ENTRYPOINT
 *   (only `CMD /entrypoint.sh`), so the compose sets `/bin/sh -c` and a script that writes the htpasswd from the
 *   environment into the container (never into the backups) and starts the server on container port 8000.
 * - `cleanup` (only with the repository password): restic opening the folder directly — so the server's append-only
 *   rule doesn't stop it — and clearing backups older than `keepDays` once a week, the first time a week after it first
 *   started, writing how it went next to the backups' folder. The by-hand variant has no cleanup: the person's NAS
 *   gets the repository password only through Whombat's own calls.
 *
 * Compose reads `$NAME` in every value as a variable, so every `$` of a value (the bcrypt line, a password, the
 * scripts) is written `$$` (`composeEscape`); `readPlaceCompose` undoes it.
 */
import { createHash } from 'node:crypto';
import { PLACE_KIT_KEEP, PLACE_KIT_USER } from '@whombat/core/backup';
import { parse, stringify } from 'yaml';
import { keepHasWindows, type PlaceKeep } from '../keep';
import { PLACE_KIT_HTPASSWD } from './htpasswd';

/**
 * The images, pinned by digest (the multi-platform index: amd64, arm64 and armv7), resolved from Docker Hub on
 * 2026-11-03. The hosts agent pins the same two; when one moves, both move.
 */
export const REST_SERVER_IMAGE =
  'restic/rest-server:0.14.0@sha256:d2aff06f47eb38637dff580c3e6bce4af98f386c396a25d32eb6727ec96214a5';
export const RESTIC_IMAGE =
  'restic/restic:0.18.1@sha256:39d9072fb5651c80d75c7a811612eb60b4c06b32ffe87c2e9f3c7222e1797e76';

/** The REST server's port inside its container. */
export const REST_CONTAINER_PORT = 8000;
/** The first host port a place tries (the next free one after it when it is taken). */
export const FIRST_PLACE_PORT = 8747;
/** The folder the backups of every Whombat on a NAS go under, and its status folder inside it. */
export const PLACE_ROOT_NAME = 'whombat-backups';
export const STATUS_DIR_NAME = '.whombat';

const CLIENT = /^[a-z0-9][a-z0-9-]{2,62}$/;

/** Whether `client` is a name a place takes (the hosts hub's rule, so the two kinds of place agree; never the kit user). */
export function validClient(client: string): boolean {
  return CLIENT.test(client) && client !== PLACE_KIT_USER;
}

/**
 * The host folder of the kit user's envelope files (backup-passkey.md): beside the backups' folder, `<folder>.kit`, so
 * it moves with them and never sits inside the repository.
 */
export function kitPathOf(dataPath: string): string {
  return `${dataPath.replace(/\/+$/, '')}.kit`;
}

/** The containers' names (BPL-01), the same on every kind of place. */
export function containerNames(client: string): { server: string; cleanup: string } {
  return { server: `whombat-backup-${client}`, cleanup: `whombat-backup-${client}-cleanup` };
}

/**
 * The project's or app's name on the NAS: `whombat-backup-<client>`, or when the NAS allows fewer characters (TrueNAS
 * 40, QNAP 32) the start of the client and six characters of its hash, so two long names never meet.
 */
export function placeAppName(client: string, max = 63): string {
  const full = `whombat-backup-${client}`;
  if (full.length <= max) return full;
  const hash = createHash('sha256').update(client).digest('hex').slice(0, 6);
  const room = Math.max(1, max - 'whombat-backup-'.length - 1 - hash.length);
  const head = client.slice(0, room).replace(/-+$/, '');
  return `whombat-backup-${head}-${hash}`;
}

/** Every `$` of a compose value doubled, so compose keeps it as it is. */
export function composeEscape(value: string): string {
  return value.replace(/\$/g, () => '$$');
}

/** A compose value as it was meant (`$$` → `$`). */
export function composeUnescape(value: string): string {
  return value.replace(/\$\$/g, () => '$');
}

export interface PlaceComposeInput {
  client: string;
  /** The host port the REST server answers on. */
  port: number;
  /** The host folder of this Whombat's backups (absolute; `./…` inside a Synology project). */
  dataPath: string;
  /** The host folder the cleanup writes how it went into (needed with `cleanup`). */
  statusPath?: string;
  /** The user's htpasswd line, `client:$2y$…` (bcrypt). */
  htpasswd: string;
  /** The weekly cleanup; null leaves it out (set up by hand, or before Whombat hands over the password). */
  cleanup: { repositoryPassword: string; keep: PlaceKeep } | null;
  /** A top-level `version:` for Container Station, whose checks may want one (compose itself ignores it). */
  withVersion?: boolean;
}

/**
 * The REST server's start: the htpasswd from the environment into the container (the client's user and the kit user),
 * then the server, only adding.
 */
const SERVER_SCRIPT = [
  'umask 077',
  `printf '%s\\n' "$HTPASSWD" "$KIT_HTPASSWD" > /tmp/.htpasswd`,
  `exec rest-server --path /data --htpasswd-file /tmp/.htpasswd --append-only --private-repos --listen :${REST_CONTAINER_PORT}`,
].join('\n');

/**
 * The cleanup (BKO-03…BKO-05): restic forgets what the person's windows don't keep and prunes, never by count; once a
 * week with only the days (a place set up before there were options), once a day with the windows. Over the space
 * limit it forgets with ever shorter windows, never the last 7 days. The period counts from the last run (the status
 * file's time) or, before the first, from when it first started (`.since`), so a NAS that restarts often still clears.
 * A failed run leaves a `.failed` marker beside the status, so a NAS whose API can list files but not read them
 * (TrueNAS) still tells.
 */
const CLEANUP_SCRIPT = [
  'set -u',
  `trap 'exit 0' TERM INT`,
  'S="/status/$CLIENT.cleanup.json"',
  'F="/status/$CLIENT.cleanup.failed"',
  'B="/status/$CLIENT.cleanup.since"',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter defaults, not a template.
  'D="${KEEP_DAILY:-0}"; W="${KEEP_WEEKLY_DAYS:-0}"; M="${KEEP_MONTHLY:-0}"; L="${LIMIT_BYTES:-0}"',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter defaults, not a template.
  'P=604800; if [ -n "${KEEP_DAILY:-}" ]; then P=86400; fi',
  'win() { set -- --keep-within "$1"d; [ "$D" -gt 0 ] && set -- "$@" --keep-within-daily "$D"d; [ "$W" -gt 0 ] && set -- "$@" --keep-within-weekly "$W"d; [ "$M" -gt 0 ] && set -- "$@" --keep-within-monthly "$M"m; echo "$@"; }',
  'run() { restic forget --group-by \'\' $(win "$1") --prune --retry-lock 2h >>/tmp/cleanup.log 2>&1; }',
  'fits() { [ "$L" -le 0 ] || [ $(( $(du -sk "$RESTIC_REPOSITORY" | cut -f1) * 1024 )) -le "$L" ]; }',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter defaults, not a template.
  'kit() { d=/kit/keys; [ -d "$d" ] || return 0; n=$((${KIT_KEEP:-10} + 1)); for a in $(sed -n \'s/.*"appliance":"\\([1-9A-HJ-NP-Za-km-z]*\\)".*/\\1/p\' "$d"/* 2>/dev/null | sort -u); do grep -l "\\"appliance\\":\\"$a\\"" "$d"/* | xargs -r ls -t | tail -n +"$n" | xargs -r rm -f; done; }',
  '[ -f "$B" ] || date -u +%s > "$B"',
  'while true; do',
  '  if [ -f "$S" ]; then base=$(stat -c %Y "$S"); else base=$(cat "$B"); fi',
  '  wait_s=$((base + P - $(date -u +%s)))',
  '  if [ "$wait_s" -gt 0 ]; then sleep "$wait_s" & wait $!; fi',
  '  : > /tmp/cleanup.log; d0=$D; w0=$W; m0=$M; over=false; ok=true',
  '  run "$KEEP_DAYS" || ok=false',
  '  all=$KEEP_DAYS; [ "$all" -lt 7 ] && all=7',
  '  for step in m6 m3 m0 w28 w0 d7; do',
  '    [ "$ok" = true ] || break; fits && break',
  '    case $step in m6) [ "$M" -gt 6 ] && M=6 || continue;; m3) [ "$M" -gt 3 ] && M=3 || continue;; m0) [ "$M" -gt 0 ] && M=0 || continue;; w28) [ "$W" -gt 28 ] && W=28 || continue;; w0) [ "$W" -gt 0 ] && W=0 || continue;; d7) [ "$D" -gt 7 ] && D=7 || continue;; esac',
  '    run "$all" || ok=false',
  '  done',
  '  [ "$ok" = true ] && ! fits && over=true',
  // The kit user's envelope files: the newest KIT_KEEP of each Whombat stay (backup-passkey.md).
  'kit',
  '  D=$d0; W=$w0; M=$m0',
  '  if [ "$ok" = true ]; then',
  '    err=""; rm -f "$F"',
  '  else',
  `    err=$(tail -n 3 /tmp/cleanup.log | tr -d '"\\\\' | tr '\\n\\r\\t' '   ' | cut -c1-300); : > "$F"`,
  '  fi',
  `  printf '{"last_run_at":"%s","last_ok":%s,"last_error":"%s","keep_within_days":%s,"over_limit":%s}\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ok" "$err" "$KEEP_DAYS" "$over" > "$S.tmp" && mv "$S.tmp" "$S"`,
  'done',
].join('\n');

/** The compose text of one Whombat's backup app. Throws on a client or port a place can't take. */
export function placeCompose(input: PlaceComposeInput): string {
  if (!validClient(input.client)) throw new Error('The backup app’s name isn’t one a NAS takes.');
  if (!Number.isInteger(input.port) || input.port < 1024 || input.port > 65535)
    throw new Error('The backup app’s port isn’t one a NAS takes.');
  if (!input.htpasswd.startsWith(`${input.client}:$2`))
    throw new Error('The backup app’s user isn’t bcrypt.');
  const names = containerNames(input.client);
  const labels = (role: string) => ({
    'whombat.service': 'backup-place',
    'whombat.client': input.client,
    'whombat.role': role,
  });
  const services: Record<string, unknown> = {
    server: {
      image: REST_SERVER_IMAGE,
      container_name: names.server,
      restart: 'unless-stopped',
      entrypoint: ['/bin/sh', '-c'],
      command: [SERVER_SCRIPT],
      environment: { HTPASSWD: input.htpasswd, KIT_HTPASSWD: PLACE_KIT_HTPASSWD },
      ports: [`${input.port}:${REST_CONTAINER_PORT}`],
      volumes: [
        `${input.dataPath}:/data/${input.client}`,
        `${kitPathOf(input.dataPath)}:/data/${PLACE_KIT_USER}`,
      ],
      labels: labels('server'),
    },
  };
  if (input.cleanup) {
    const k = input.cleanup.keep;
    if (
      ![k.allDays, k.dailyDays, k.weeklyWeeks, k.monthlyMonths].every((n) => Number.isInteger(n) && n >= 0) ||
      k.allDays < 1
    )
      throw new Error('The cleanup’s days aren’t whole numbers.');
    if (!input.statusPath) throw new Error('The cleanup needs a folder for its status.');
    services.cleanup = {
      image: RESTIC_IMAGE,
      container_name: names.cleanup,
      restart: 'unless-stopped',
      entrypoint: ['/bin/sh', '-c'],
      command: [CLEANUP_SCRIPT],
      environment: {
        CLIENT: input.client,
        KEEP_DAYS: String(input.cleanup.keep.allDays),
        ...(keepHasWindows(input.cleanup.keep)
          ? {
              KEEP_DAILY: String(input.cleanup.keep.dailyDays),
              KEEP_WEEKLY_DAYS: String(input.cleanup.keep.weeklyWeeks * 7),
              KEEP_MONTHLY: String(input.cleanup.keep.monthlyMonths),
              LIMIT_BYTES: String(input.cleanup.keep.limitBytes ?? 0),
            }
          : {}),
        RESTIC_REPOSITORY: `/data/${input.client}`,
        RESTIC_PASSWORD: input.cleanup.repositoryPassword,
        RESTIC_CACHE_DIR: '/tmp/restic-cache',
        KIT_KEEP: String(PLACE_KIT_KEEP),
      },
      volumes: [
        `${input.dataPath}:/data/${input.client}`,
        `${input.statusPath}:/status`,
        `${kitPathOf(input.dataPath)}:/kit`,
      ],
      labels: labels('cleanup'),
    };
  }
  const doc = escapeAll({ ...(input.withVersion ? { version: '3.8' } : {}), services });
  return stringify(doc, { lineWidth: 0 });
}

function escapeAll(value: unknown): unknown {
  if (typeof value === 'string') return composeEscape(value);
  if (Array.isArray(value)) return value.map(escapeAll);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, escapeAll(v)]));
  return value;
}

/** What a deployed backup app holds that a redeploy keeps. */
export interface PlaceComposeState {
  port: number | null;
  /** The host folder the backups are in (kept on a redeploy: the repository is there). */
  dataPath: string | null;
  htpasswd: string | null;
  cleanup: { repositoryPassword: string; keep: PlaceKeep } | null;
}

/**
 * Reads a deployed backup app back (the compose text a NAS keeps, or TrueNAS's parsed `app.config`): its port, its
 * user's line and its cleanup, with `$$` undone. Missing parts are null; it never throws.
 */
export function readPlaceCompose(
  source: string | Record<string, unknown> | null | undefined,
): PlaceComposeState {
  const none: PlaceComposeState = { port: null, dataPath: null, htpasswd: null, cleanup: null };
  let doc: unknown = source;
  if (typeof source === 'string') {
    try {
      doc = parse(source);
    } catch {
      return none;
    }
  }
  const services = record(record(doc)?.services);
  if (!services) return none;
  const server = record(services.server);
  const cleanup = record(services.cleanup);
  const port = portOf(server?.ports);
  const htpasswd = envOf(server?.environment, 'HTPASSWD');
  const repositoryPassword = envOf(cleanup?.environment, 'RESTIC_PASSWORD');
  const env = (name: string) => Number(envOf(cleanup?.environment, name) ?? 0);
  const keepDays = Number(envOf(cleanup?.environment, 'KEEP_DAYS'));
  const limit = env('LIMIT_BYTES');
  return {
    port,
    dataPath: dataPathOf(server?.volumes),
    htpasswd,
    cleanup:
      repositoryPassword && Number.isInteger(keepDays) && keepDays > 0
        ? {
            repositoryPassword,
            keep: {
              allDays: keepDays,
              dailyDays: env('KEEP_DAILY') || 0,
              weeklyWeeks: Math.round((env('KEEP_WEEKLY_DAYS') || 0) / 7),
              monthlyMonths: env('KEEP_MONTHLY') || 0,
              limitBytes: limit > 0 ? limit : null,
            },
          }
        : null,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The host port of the first mapping to the container's 8000 (`"8747:8000"` or the long form). */
function portOf(ports: unknown): number | null {
  if (!Array.isArray(ports)) return null;
  for (const p of ports) {
    if (typeof p === 'string' || typeof p === 'number') {
      const m = /^(?:[\d.]+:)?(\d+):(\d+)(?:\/tcp)?$/.exec(String(p));
      if (m && Number(m[2]) === REST_CONTAINER_PORT) return Number(m[1]);
    }
    const long = record(p);
    if (long && Number(long.target) === REST_CONTAINER_PORT && long.published !== undefined)
      return Number(long.published) || null;
  }
  return null;
}

/** The host side of the mount on `/data/<client>`. */
function dataPathOf(volumes: unknown): string | null {
  if (!Array.isArray(volumes)) return null;
  for (const v of volumes) {
    if (typeof v === 'string') {
      const m = /^(.+):(\/data\/[a-z0-9-]+)(?::[a-z,]+)?$/.exec(v);
      if (m?.[1] && m[2] !== `/data/${PLACE_KIT_USER}`) return composeUnescape(m[1]);
    }
    const long = record(v);
    if (
      long &&
      typeof long.source === 'string' &&
      String(long.target ?? '').startsWith('/data/') &&
      long.target !== `/data/${PLACE_KIT_USER}`
    )
      return composeUnescape(long.source);
  }
  return null;
}

/** One environment value, in the map form or the `NAME=value` list form. */
function envOf(env: unknown, name: string): string | null {
  const map = record(env);
  if (map) return typeof map[name] === 'string' ? composeUnescape(map[name] as string) : null;
  if (Array.isArray(env))
    for (const item of env)
      if (typeof item === 'string' && item.startsWith(`${name}=`))
        return composeUnescape(item.slice(name.length + 1));
  return null;
}

/** The first port from `FIRST_PLACE_PORT` that isn't in `used`. */
export function freePlacePort(used: Iterable<number>): number {
  const taken = new Set(used);
  let port = FIRST_PLACE_PORT;
  while (taken.has(port) && port < 65535) port++;
  return port;
}
