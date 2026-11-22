/**
 * Immich's declared settings: read from `/api/system-config` (falling back to `/api/admin/config` on 404). Every row
 * stays read-only (“In Immich”): Immich only accepts a full-object `PUT` with no conditional write, and that object
 * carries password sign-in, OAuth, server URLs, trash and database backups — so any write could overwrite a concurrent
 * change to sign-in or data keeping. Changing “Convert videos” can also make the next transcode job delete converted
 * copies. Non-admin API keys get a plain explanation in the settings tab.
 */
import type { CatalogConnectionRow } from '../../../connections/types';
import type { Services } from '../../../services';
import { num, rec, str } from '../../words';
import { getJson, ReadProblem } from '../read';
import { asBool, type DeclaredSettings, type SettingSpec, type SettingValue } from '../settings';

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

/** Detects whether this Immich config names smart search `clip` (v1/v2) or `smartSearch`. */
function smartSearchKey(s: ImmichSettingsState): 'clip' | 'smartSearch' | null {
  const ml = rec(s.raw.machineLearning);
  if ('clip' in ml) return 'clip';
  if ('smartSearch' in ml) return 'smartSearch';
  return null;
}

const TRANSCODE_WORDS: Record<string, string> = {
  required: 'Only when needed',
  bitrate: 'High-bitrate videos',
  all: 'Every video',
  disabled: 'Off',
};

const RESOLUTION_WORDS: Record<string, string> = {
  original: 'Original size',
  '2160': '4K · 2160p',
  '1440': '1440p',
  '1080': '1080p',
  '720': '720p',
  '480': '480p',
};

function transcodeWords(v: SettingValue): string {
  const s = String(v);
  return TRANSCODE_WORDS[s] ?? s;
}

function resolutionWords(v: SettingValue): string {
  const s = String(v);
  return RESOLUTION_WORDS[s] ?? `${s}p`;
}

const onOff = (v: SettingValue) => (asBool(v) ? 'On' : 'Off');
const daysWords = (v: SettingValue) => (Number(v) === 1 ? '1 day' : `${Number(v)} days`);
const backupsWords = (v: SettingValue) => (Number(v) === 1 ? '1 backup' : `${Number(v)} backups`);
const settingsPage = (base: string) => `${base}/admin/system-settings`;

export const IMMICH_SETTING_SPECS: readonly SettingSpec<ImmichSettingsState>[] = [
  {
    id: 'video_transcode',
    group: 'video',
    label: 'Convert videos',
    help: 'When Immich makes a smaller copy of a video. Changing it can delete converted copies on the next transcode job, and Immich saves all settings together, so it stays in Immich.',
    kind: 'elsewhere',
    read: (s) => strAt(s, ['ffmpeg', 'transcode']),
    words: transcodeWords,
    elsewhere: settingsPage,
  },
  {
    id: 'video_resolution',
    group: 'video',
    label: 'Converted video size',
    help: 'The highest resolution Immich converts videos to. Immich saves all server settings together, including sign-in, so it stays in Immich.',
    kind: 'elsewhere',
    read: (s) => strAt(s, ['ffmpeg', 'targetResolution']),
    words: resolutionWords,
    elsewhere: settingsPage,
  },
  {
    id: 'machine_learning',
    group: 'ml',
    label: 'Smart features',
    help: 'Run smart search, face recognition and duplicate checks on new uploads. Immich saves all server settings together, including sign-in, so it stays in Immich.',
    kind: 'elsewhere',
    read: (s) => boolAt(s, ['machineLearning', 'enabled']),
    words: onOff,
    elsewhere: settingsPage,
  },
  {
    id: 'smart_search',
    group: 'ml',
    label: 'Smart search',
    help: 'Search your photos by what is in them. Immich saves all server settings together, including sign-in, so it stays in Immich.',
    kind: 'elsewhere',
    read: (s) => {
      const key = smartSearchKey(s);
      return key ? boolAt(s, ['machineLearning', key, 'enabled']) : undefined;
    },
    words: onOff,
    elsewhere: settingsPage,
  },
  {
    id: 'face_recognition',
    group: 'ml',
    label: 'Face recognition',
    help: 'Group photos by the people in them. Immich saves all server settings together, including sign-in, so it stays in Immich.',
    kind: 'elsewhere',
    read: (s) => boolAt(s, ['machineLearning', 'facialRecognition', 'enabled']),
    words: onOff,
    elsewhere: settingsPage,
  },
  {
    id: 'duplicate_detection',
    group: 'ml',
    label: 'Find duplicates',
    help: 'Spot duplicate photos and videos automatically. Immich saves all server settings together, including sign-in, so it stays in Immich.',
    kind: 'elsewhere',
    read: (s) => boolAt(s, ['machineLearning', 'duplicateDetection', 'enabled']),
    words: onOff,
    elsewhere: settingsPage,
  },
  {
    id: 'trash_days',
    group: 'safety',
    label: 'Keep trash for',
    help: 'How long deleted photos stay in the trash before permanent removal. Shortening it deletes older items, so it stays in Immich.',
    kind: 'elsewhere',
    read: (s) => (boolAt(s, ['trash', 'enabled']) === false ? undefined : numAt(s, ['trash', 'days'])),
    words: daysWords,
    elsewhere: settingsPage,
  },
  {
    id: 'db_backup_enabled',
    group: 'safety',
    label: 'Automatic database backups',
    help: 'Save a regular backup of Immich’s database. Turning it off stops keeping backups, and running it prunes older ones, so it stays in Immich.',
    kind: 'elsewhere',
    read: (s) => boolAt(s, ['backup', 'database', 'enabled']),
    words: onOff,
    elsewhere: settingsPage,
  },
  {
    id: 'db_backup_keep',
    group: 'safety',
    label: 'Database backups to keep',
    help: 'How many recent database backups Immich keeps. Lowering it deletes older backups, so it stays in Immich.',
    kind: 'elsewhere',
    read: (s) => numAt(s, ['backup', 'database', 'keepLastAmount']),
    words: backupsWords,
    elsewhere: settingsPage,
  },
  {
    id: 'version_check',
    group: 'upkeep',
    label: 'Check for updates',
    help: 'Let Immich check whether a newer version is out. Immich saves all server settings together, including sign-in, so it stays in Immich.',
    kind: 'elsewhere',
    read: (s) => boolAt(s, ['newVersionCheck', 'enabled']),
    words: onOff,
    elsewhere: settingsPage,
  },
  {
    id: 'auth_and_users',
    group: 'upkeep',
    label: 'Sign-in, storage and users',
    help: 'Passwords, single sign-on, storage folders and user accounts stay in Immich.',
    kind: 'elsewhere',
    read: () => 'Managed in Immich',
    elsewhere: settingsPage,
  },
];

export const IMMICH_SETTINGS: DeclaredSettings<ImmichSettingsState> = {
  name: NAME,
  url: settingsPage,
  unread: (err) =>
    err instanceof ReadProblem && err.httpStatus === 403
      ? 'Only an Immich administrator’s API key can read server settings. You can still view and change them in Immich.'
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
