/**
 * Plex's settings that matter: read from `/:/prefs`, written with field-only `PUT /:/prefs?<id>=<value>`, in four
 * groups — watching away from home, converting video, libraries, upkeep. Remote access, secure connections, emptying
 * the trash and updates stay in Plex: turning remote access off cuts off access from outside the home, requiring
 * encryption immediately refuses plain HTTP on port 32400 (cutting off plain-HTTP local access and Whombat's default
 * HTTP connection), emptying the trash can drop a library when a drive is briefly away, and installing an update
 * restarts the server.
 */
import type { CatalogConnectionRow } from '../../../connections/types';
import type { Services } from '../../../services';
import { list, num, rec, str } from '../../words';
import { getJson } from '../read';
import {
  asBool,
  type DeclaredSettings,
  type SettingChoice,
  type SettingSpec,
  type SettingValue,
  withCurrent,
} from '../settings';

/** Plex's prefs by id, as Plex types them (booleans, numbers, words). */
export interface PlexPrefs {
  values: Map<string, SettingValue>;
}

/** `GET /:/prefs`: `MediaContainer.Setting[]` with `id` and `value`. */
export function parsePrefs(body: unknown): PlexPrefs {
  const values = new Map<string, SettingValue>();
  for (const raw of list(rec(rec(body).MediaContainer).Setting).slice(0, 600)) {
    const s = rec(raw);
    const id = str(s.id);
    if (!id) continue;
    const v = s.value;
    if (typeof v === 'boolean' || typeof v === 'number') values.set(id, v);
    else if (typeof v === 'string') values.set(id, v.slice(0, 200));
  }
  return { values };
}

export async function readPlexPrefs(services: Services, row: CatalogConnectionRow): Promise<PlexPrefs> {
  return parsePrefs(await getJson(services, row, 'Plex', '/:/prefs'));
}

const pref = (p: PlexPrefs, id: string) => p.values.get(id);
const prefNum = (p: PlexPrefs, id: string) => {
  const v = pref(p, id);
  return v === undefined ? undefined : (num(v) ?? undefined);
};
const prefBool = (p: PlexPrefs, id: string) => {
  const v = pref(p, id);
  return v === undefined ? undefined : (asBool(v) ?? undefined);
};

/** One call that sets Plex's prefs. */
const put = (values: Record<string, string>) => ({ method: 'PUT' as const, path: '/:/prefs', query: values });
const bit = (v: SettingValue) => (asBool(v) ? '1' : '0');

/** A Plex rate in kbps as Mbps: “20 Mbps”, “1.5 Mbps”. */
export function mbps(kbps: number): string {
  const m = kbps / 1000;
  return `${Number.isInteger(m) ? m : Math.round(m * 10) / 10} Mbps`;
}

const QUALITY: SettingChoice[] = [
  { value: 0, label: 'Original quality', note: 'no limit' },
  { value: 20000, label: '20 Mbps', note: '1080p, high' },
  { value: 12000, label: '12 Mbps', note: '1080p' },
  { value: 8000, label: '8 Mbps', note: '1080p' },
  { value: 4000, label: '4 Mbps', note: '720p' },
  { value: 2000, label: '2 Mbps', note: '720p, low' },
];

const SECURE_WORDS: Record<string, string> = { '0': 'Required', '1': 'Preferred', '2': 'Off' };

const CONVERT_QUALITY: SettingChoice[] = [
  { value: 0, label: 'Automatic' },
  { value: 1, label: 'Faster', note: 'less work for the machine' },
  { value: 2, label: 'Better picture', note: 'more work for the machine' },
];
const CONVERT_WORDS: Record<string, string> = {
  '0': 'Automatic',
  '1': 'Faster',
  '2': 'Better picture',
  '3': 'Best picture',
};

const AT_ONCE = [0, 1, 2, 3, 4, 6, 8];
const atOnceWords = (v: SettingValue) => (Number(v) === 0 ? 'No limit' : `At most ${Number(v)}`);

const SCHEDULE: SettingChoice[] = [
  { value: 0, label: 'Off' },
  { value: 3600, label: 'Every hour' },
  { value: 7200, label: 'Every 2 hours' },
  { value: 21600, label: 'Every 6 hours' },
  { value: 43200, label: 'Every 12 hours' },
  { value: 86400, label: 'Every day' },
];
const scheduleWords = (v: SettingValue) => {
  const s = Number(v);
  if (s === 0) return 'Off';
  const known = SCHEDULE.find((c) => c.value === s);
  if (known) return known.label;
  return s < 3600 ? `Every ${Math.round(s / 60)} minutes` : `Every ${Math.round(s / 3600)} hours`;
};

const hour = (h: number) => `${String(h).padStart(2, '0')}:00`;
const hoursWords = (v: SettingValue) => {
  const [a, b] = String(v).split('-').map(Number);
  return `${hour(a ?? 0)} – ${hour(b ?? 0)}`;
};
const QUIET: SettingChoice[] = [0, 1, 2, 3, 4].map((h) => ({
  value: `${h}-${h + 3}`,
  label: hoursWords(`${h}-${h + 3}`),
}));

export const PLEX_SETTING_SPECS: readonly SettingSpec<PlexPrefs>[] = [
  {
    id: 'remote_access',
    group: 'away',
    label: 'Remote access',
    // Turning remote access off cuts off people reaching Plex from outside the home in one click.
    help: 'People can watch outside your home. Turning it off can cut off access from outside, so it stays in Plex.',
    kind: 'elsewhere',
    read: (p) => prefBool(p, 'PublishServerOnPlexOnlineKey'),
    words: (v) => (asBool(v) ? 'On' : 'Off'),
  },
  {
    id: 'remote_quality',
    group: 'away',
    label: 'Quality outside your home',
    help: 'The most one stream may use. Higher looks better, but needs a faster upload.',
    sheetHelp: 'The most one stream may use when someone watches away from home.',
    kind: 'choice',
    read: (p) => prefNum(p, 'WanPerStreamMaxUploadRate'),
    choices: (p) => withCurrent(QUALITY, prefNum(p, 'WanPerStreamMaxUploadRate'), (v) => mbps(Number(v))),
    words: (v) => (Number(v) === 0 ? 'Original quality' : `Up to ${mbps(Number(v))}`),
    short: (v) => (Number(v) === 0 ? 'original quality' : mbps(Number(v))),
    sentence: (v) =>
      Number(v) === 0
        ? 'Plex now sends the original quality outside your home.'
        : `Plex now allows up to ${mbps(Number(v))} outside your home.`,
    write: (v) => put({ WanPerStreamMaxUploadRate: String(Number(v)) }),
    hint: (p) => {
      const total = prefNum(p, 'WanTotalMaxUploadRate');
      return total && total > 0
        ? `Plex sends at most ${mbps(total)} in all to people away from home.`
        : undefined;
    },
  },
  {
    id: 'secure_connections',
    group: 'away',
    label: 'Secure connections',
    // Requiring encryption (`secureConnections=0`) makes Plex refuse plain HTTP on port 32400 from non-localhost
    // addresses, cutting off plain-HTTP LAN access and Whombat's default HTTP connection before Undo can run.
    help: 'Whether Plex only accepts encrypted connections. Requiring encryption stops plain HTTP access on port 32400, so it stays in Plex.',
    kind: 'elsewhere',
    read: (p) => prefNum(p, 'secureConnections'),
    words: (v) => SECURE_WORDS[String(v)] ?? String(v),
  },
  {
    id: 'graphics_chip',
    group: 'convert',
    label: 'Use the graphics chip',
    help: 'Converts faster and keeps the processor free.',
    kind: 'switch',
    read: (p) => prefBool(p, 'HardwareAcceleratedCodecs'),
    write: (v) => put({ HardwareAcceleratedCodecs: bit(v) }),
    sentence: (v) =>
      asBool(v)
        ? 'Plex now uses the graphics chip to convert video.'
        : 'Plex now converts video on the processor.',
  },
  {
    id: 'conversion_quality',
    group: 'convert',
    label: 'Conversion quality',
    help: 'How hard Plex works when a device can’t play a file as it is.',
    kind: 'choice',
    read: (p) => prefNum(p, 'TranscoderQuality'),
    choices: (p) =>
      withCurrent(
        CONVERT_QUALITY,
        prefNum(p, 'TranscoderQuality'),
        (v) => CONVERT_WORDS[String(v)] ?? String(v),
      ),
    words: (v) => CONVERT_WORDS[String(v)] ?? String(v),
    sentence: (v) =>
      `Plex now converts with ${(CONVERT_WORDS[String(v)] ?? String(v)).toLowerCase()} quality.`,
    write: (v) => put({ TranscoderQuality: String(Number(v)) }),
  },
  {
    id: 'conversions_at_once',
    group: 'convert',
    label: 'Conversions at once',
    help: 'More lets more people watch, but makes the machine busier.',
    kind: 'choice',
    read: (p) => prefNum(p, 'TranscodeCountLimit'),
    choices: (p) =>
      withCurrent(
        AT_ONCE.map((n) => ({ value: n, label: atOnceWords(n) })),
        prefNum(p, 'TranscodeCountLimit'),
        atOnceWords,
      ),
    words: atOnceWords,
    short: (v) => (Number(v) === 0 ? 'no limit' : String(Number(v))),
    sentence: (v) =>
      Number(v) === 0
        ? 'Plex now converts as many streams at once as asked.'
        : `Plex now converts at most ${Number(v)} at once.`,
    write: (v) => put({ TranscodeCountLimit: String(Number(v)) }),
  },
  {
    id: 'scan_on_change',
    group: 'libraries',
    label: 'Scan when files change',
    help: 'New films show up within a minute.',
    kind: 'switch',
    read: (p) => prefBool(p, 'FSEventLibraryUpdatesEnabled'),
    write: (v) => put({ FSEventLibraryUpdatesEnabled: bit(v) }),
    sentence: (v) =>
      asBool(v) ? 'Plex now scans as soon as files change.' : 'Plex no longer scans when files change.',
  },
  {
    id: 'scan_schedule',
    group: 'libraries',
    label: 'Scan on a schedule',
    help: 'Catches anything the first one missed.',
    kind: 'choice',
    read: (p) => {
      const on = prefBool(p, 'ScheduledLibraryUpdatesEnabled');
      if (on === undefined) return undefined;
      return on ? (prefNum(p, 'ScheduledLibraryUpdateInterval') ?? 3600) : 0;
    },
    choices: (p) => {
      const on = prefBool(p, 'ScheduledLibraryUpdatesEnabled');
      const every = prefNum(p, 'ScheduledLibraryUpdateInterval');
      return withCurrent(SCHEDULE, on ? every : 0, scheduleWords);
    },
    words: scheduleWords,
    short: (v) => scheduleWords(v).toLowerCase(),
    sentence: (v) =>
      Number(v) === 0
        ? 'Plex no longer scans on a schedule.'
        : `Plex now scans ${scheduleWords(v).toLowerCase()}.`,
    write: (v) =>
      Number(v) === 0
        ? put({ ScheduledLibraryUpdatesEnabled: '0' })
        : put({ ScheduledLibraryUpdatesEnabled: '1', ScheduledLibraryUpdateInterval: String(Number(v)) }),
  },
  {
    id: 'empty_trash',
    group: 'libraries',
    label: 'Empty the trash after a scan',
    help: 'Removed files leave Plex at once. It stays in Plex: a drive away for a moment could empty a library.',
    kind: 'elsewhere',
    read: (p) => prefBool(p, 'autoEmptyTrash'),
  },
  {
    id: 'quiet_hours',
    group: 'upkeep',
    label: 'Quiet hours for upkeep',
    help: 'When Plex optimises its database and makes previews.',
    kind: 'choice',
    read: (p) => {
      const a = prefNum(p, 'ButlerStartHour');
      const b = prefNum(p, 'ButlerEndHour');
      return a === undefined || b === undefined ? undefined : `${a}-${b}`;
    },
    choices: (p) => {
      const a = prefNum(p, 'ButlerStartHour');
      const b = prefNum(p, 'ButlerEndHour');
      return withCurrent(QUIET, a === undefined || b === undefined ? undefined : `${a}-${b}`, hoursWords);
    },
    words: hoursWords,
    sentence: (v) => `Plex now does its upkeep from ${hoursWords(v).replace(' – ', ' to ')}.`,
    write: (v) => {
      const [a, b] = String(v).split('-').map(Number);
      return put({ ButlerStartHour: String(a ?? 2), ButlerEndHour: String(b ?? 5) });
    },
  },
  {
    id: 'updates',
    group: 'upkeep',
    label: 'Updates',
    help: 'Installing a new version restarts Plex, so it stays in Plex.',
    kind: 'elsewhere',
    // Plex's own “update my server automatically”, else only that Plex tells you.
    read: (p) => prefBool(p, 'ButlerTaskUpdateVersion') ?? 'tells',
    words: (v) => (v === 'tells' ? 'Plex tells you' : asBool(v) ? 'Automatic' : 'Ask me'),
  },
];

export const PLEX_SETTINGS: DeclaredSettings<PlexPrefs> = {
  name: 'Plex',
  url: (base) => `${base}/web/index.html#!/settings/server`,
  groups: [
    {
      id: 'away',
      title: 'Watching away from home',
      ask: ['Why is Plex slow away from home?', 'What quality should I use outside my home?'],
    },
    {
      id: 'convert',
      title: 'Converting video',
      ask: ['Why does Plex convert so much?', 'Can Plex use my server’s graphics chip?'],
    },
    { id: 'libraries', title: 'Libraries', ask: ['Why doesn’t a new film show up in Plex?'] },
    { id: 'upkeep', title: 'Upkeep', ask: ['What does Plex do during its upkeep?'] },
  ],
  specs: PLEX_SETTING_SPECS,
  read: readPlexPrefs,
};
