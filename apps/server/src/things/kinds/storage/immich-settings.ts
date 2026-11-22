/**
 * Immich's declared settings: read from `/api/system-config` (falling back to `/api/admin/config` on 404), written
 * back with `PUT` to the same path while preserving every untouched field (auth, storage template, server URLs).
 * Non-admin API keys get a plain explanation in the settings tab.
 */
import type { CatalogConnectionRow } from '../../../connections/types';
import type { Services } from '../../../services';
import { num, rec, str } from '../../words';
import { getJson, ReadProblem } from '../read';
import {
  asBool,
  type DeclaredSettings,
  type SettingChoice,
  type SettingSpec,
  type SettingValue,
  withCurrent,
} from '../settings';

const NAME = 'Immich';

export interface ImmichSettingsState {
  path: '/api/system-config' | '/api/admin/config';
  raw: Record<string, unknown>;
}

/** Parses Immich's system config object alongside the endpoint path it was read from. */
export function parseImmichSettings(
  body: unknown,
  path: '/api/system-config' | '/api/admin/config' = '/api/system-config',
): ImmichSettingsState {
  const raw = rec(body);
  return { path, raw: structuredClone(raw) };
}

export async function readImmichSettings(
  services: Services,
  row: CatalogConnectionRow,
): Promise<ImmichSettingsState> {
  try {
    return parseImmichSettings(
      await getJson(services, row, NAME, '/api/system-config'),
      '/api/system-config',
    );
  } catch (err) {
    if (err instanceof ReadProblem && err.httpStatus === 404) {
      return parseImmichSettings(
        await getJson(services, row, NAME, '/api/admin/config'),
        '/api/admin/config',
      );
    }
    throw err;
  }
}

/** Reads a nested property from the raw config object. */
function atPath(raw: Record<string, unknown>, keys: readonly string[]): unknown {
  let cur: unknown = raw;
  for (const k of keys) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** Returns a deep copy of `raw` with only the nested leaf at `keys` changed. */
function setPath(
  raw: Record<string, unknown>,
  keys: readonly string[],
  value: unknown,
): Record<string, unknown> {
  const copy = structuredClone(raw);
  let cur: Record<string, unknown> = copy;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i] as string;
    const next = cur[k];
    if (!next || typeof next !== 'object' || Array.isArray(next)) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  const leaf = keys[keys.length - 1] as string;
  cur[leaf] = value;
  return copy;
}

const boolAt = (s: ImmichSettingsState, keys: readonly string[]): boolean | undefined => {
  const v = atPath(s.raw, keys);
  return typeof v === 'boolean' ? v : undefined;
};

const numAt = (s: ImmichSettingsState, keys: readonly string[]): number | undefined => {
  const n = num(atPath(s.raw, keys));
  return n === null ? undefined : n;
};

const strAt = (s: ImmichSettingsState, keys: readonly string[]): string | undefined =>
  str(atPath(s.raw, keys)) ?? undefined;

const putAt = (s: ImmichSettingsState, keys: readonly string[], value: unknown) => ({
  method: 'PUT' as const,
  path: s.path,
  body: setPath(s.raw, keys, value),
});

/** Detects whether this Immich config names smart search `clip` (v1/v2) or `smartSearch`. */
function smartSearchKey(s: ImmichSettingsState): 'clip' | 'smartSearch' | null {
  const ml = rec(s.raw.machineLearning);
  if ('clip' in ml) return 'clip';
  if ('smartSearch' in ml) return 'smartSearch';
  return null;
}

const TRANSCODE_CHOICES: SettingChoice[] = [
  { value: 'required', label: 'Only when needed', note: 'plays on every device' },
  { value: 'bitrate', label: 'High-bitrate videos', note: 'when over the bitrate limit' },
  { value: 'all', label: 'Every video', note: 'uses more disk space' },
  { value: 'disabled', label: 'Off', note: 'original files only' },
];

const RESOLUTION_CHOICES: SettingChoice[] = [
  { value: 'original', label: 'Original size' },
  { value: '2160', label: '4K · 2160p' },
  { value: '1440', label: '1440p' },
  { value: '1080', label: '1080p' },
  { value: '720', label: '720p' },
  { value: '480', label: '480p' },
];

function resolutionWords(v: SettingValue): string {
  const s = String(v);
  return RESOLUTION_CHOICES.find((c) => c.value === s)?.label ?? `${s}p`;
}

const daysWords = (v: SettingValue) => (Number(v) === 1 ? '1 day' : `${Number(v)} days`);
const backupsWords = (v: SettingValue) => (Number(v) === 1 ? '1 backup' : `${Number(v)} backups`);

export const IMMICH_SETTING_SPECS: readonly SettingSpec<ImmichSettingsState>[] = [
  {
    id: 'video_transcode',
    group: 'video',
    label: 'Convert videos',
    help: 'When Immich makes a smaller web-friendly copy of a video.',
    kind: 'choice',
    read: (s) => strAt(s, ['ffmpeg', 'transcode']),
    choices: (s) => withCurrent(TRANSCODE_CHOICES, strAt(s, ['ffmpeg', 'transcode']), (v) => String(v)),
    write: (v, s) => putAt(s, ['ffmpeg', 'transcode'], String(v)),
    sentence: (v) => {
      const label = TRANSCODE_CHOICES.find((c) => c.value === String(v))?.label ?? String(v);
      return `Immich now converts videos: ${label.toLowerCase()}.`;
    },
  },
  {
    id: 'video_resolution',
    group: 'video',
    label: 'Converted video size',
    help: 'The highest resolution Immich converts videos to.',
    kind: 'choice',
    read: (s) => strAt(s, ['ffmpeg', 'targetResolution']),
    choices: (s) =>
      withCurrent(RESOLUTION_CHOICES, strAt(s, ['ffmpeg', 'targetResolution']), resolutionWords),
    words: resolutionWords,
    write: (v, s) => putAt(s, ['ffmpeg', 'targetResolution'], String(v)),
    sentence: (v) => `Immich now converts videos up to ${resolutionWords(v)}.`,
  },
  {
    id: 'machine_learning',
    group: 'ml',
    label: 'Smart features',
    help: 'Run smart search, face recognition and duplicate checks on new uploads.',
    kind: 'switch',
    read: (s) => boolAt(s, ['machineLearning', 'enabled']),
    write: (v, s) => putAt(s, ['machineLearning', 'enabled'], asBool(v) === true),
    sentence: (v) =>
      asBool(v) ? 'Smart features are now on in Immich.' : 'Smart features are now off in Immich.',
  },
  {
    id: 'smart_search',
    group: 'ml',
    label: 'Smart search',
    help: 'Search your photos by what is in them.',
    kind: 'switch',
    read: (s) => {
      const key = smartSearchKey(s);
      return key ? boolAt(s, ['machineLearning', key, 'enabled']) : undefined;
    },
    write: (v, s) => {
      const key = smartSearchKey(s) ?? 'clip';
      return putAt(s, ['machineLearning', key, 'enabled'], asBool(v) === true);
    },
    sentence: (v) => (asBool(v) ? 'Smart search is now on in Immich.' : 'Smart search is now off in Immich.'),
  },
  {
    id: 'face_recognition',
    group: 'ml',
    label: 'Face recognition',
    help: 'Group photos by the people in them.',
    kind: 'switch',
    read: (s) => boolAt(s, ['machineLearning', 'facialRecognition', 'enabled']),
    write: (v, s) => putAt(s, ['machineLearning', 'facialRecognition', 'enabled'], asBool(v) === true),
    sentence: (v) =>
      asBool(v) ? 'Face recognition is now on in Immich.' : 'Face recognition is now off in Immich.',
  },
  {
    id: 'duplicate_detection',
    group: 'ml',
    label: 'Find duplicates',
    help: 'Spot duplicate photos and videos automatically.',
    kind: 'switch',
    read: (s) => boolAt(s, ['machineLearning', 'duplicateDetection', 'enabled']),
    write: (v, s) => putAt(s, ['machineLearning', 'duplicateDetection', 'enabled'], asBool(v) === true),
    sentence: (v) =>
      asBool(v) ? 'Duplicate detection is now on in Immich.' : 'Duplicate detection is now off in Immich.',
  },
  {
    id: 'trash_days',
    group: 'safety',
    label: 'Keep trash for',
    help: 'How long deleted photos stay in the trash before permanent removal. Shortening it deletes older items, so it stays in Immich.',
    kind: 'elsewhere',
    read: (s) => (boolAt(s, ['trash', 'enabled']) === false ? undefined : numAt(s, ['trash', 'days'])),
    words: daysWords,
    elsewhere: (base) => `${base}/admin/system-settings`,
  },
  {
    id: 'db_backup_enabled',
    group: 'safety',
    label: 'Automatic database backups',
    help: 'Save a regular backup of Immich’s database. Turning it off stops keeping backups, and running it prunes older ones, so it stays in Immich.',
    kind: 'elsewhere',
    read: (s) => boolAt(s, ['backup', 'database', 'enabled']),
    words: (v) => (asBool(v) ? 'On' : 'Off'),
    elsewhere: (base) => `${base}/admin/system-settings`,
  },
  {
    id: 'db_backup_keep',
    group: 'safety',
    label: 'Database backups to keep',
    help: 'How many recent database backups Immich keeps. Lowering it deletes older backups, so it stays in Immich.',
    kind: 'elsewhere',
    read: (s) => numAt(s, ['backup', 'database', 'keepLastAmount']),
    words: backupsWords,
    elsewhere: (base) => `${base}/admin/system-settings`,
  },
  {
    id: 'version_check',
    group: 'upkeep',
    label: 'Check for updates',
    help: 'Let Immich check whether a newer version is out.',
    kind: 'switch',
    read: (s) => boolAt(s, ['newVersionCheck', 'enabled']),
    write: (v, s) => putAt(s, ['newVersionCheck', 'enabled'], asBool(v) === true),
    sentence: (v) => (asBool(v) ? 'Immich now checks for updates.' : 'Immich no longer checks for updates.'),
  },
  {
    id: 'auth_and_users',
    group: 'upkeep',
    label: 'Sign-in, storage and users',
    help: 'Passwords, single sign-on, storage folders and user accounts stay in Immich.',
    kind: 'elsewhere',
    read: () => 'Managed in Immich',
    elsewhere: (base) => `${base}/admin/system-settings`,
  },
];

export const IMMICH_SETTINGS: DeclaredSettings<ImmichSettingsState> = {
  name: NAME,
  url: (base) => `${base}/admin/system-settings`,
  unread: (err) =>
    err instanceof ReadProblem && err.httpStatus === 403
      ? 'Only an Immich administrator’s API key can read and change server settings. You can still change them in Immich.'
      : undefined,
  groups: [
    {
      id: 'video',
      title: 'Video conversion',
      ask: ['When should Immich convert my videos?', 'How much space does video conversion take?'],
    },
    {
      id: 'ml',
      title: 'Smart features',
      ask: ['Does face recognition slow down my server?', 'How does Immich find duplicate photos?'],
    },
    {
      id: 'safety',
      title: 'Trash and backups',
      ask: [
        'How long does Immich keep deleted photos in the trash?',
        'Where does Immich store its database backups?',
      ],
    },
    {
      id: 'upkeep',
      title: 'Upkeep',
      ask: ['What happens if I turn off Immich version checks?'],
    },
  ],
  specs: IMMICH_SETTING_SPECS,
  read: readImmichSettings,
};
