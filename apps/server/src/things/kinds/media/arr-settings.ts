/**
 * Sonarr's and Radarr's declared settings: read from `/api/v3/config/mediamanagement`, `/api/v3/config/naming`,
 * `/api/v3/config/downloadclient` and `/api/v3/config/indexer`. Every row stays read-only (“In Sonarr” / “In Radarr”):
 * Sonarr and Radarr v3 config endpoints only accept whole-section `PUT /api/v3/config/<section>/<id>` with no
 * field-only `PATCH` or conditional `If-Match`, so any write could silently overwrite a concurrent change to sibling
 * settings. Media management, download handling and host settings also carry file-replacement, recycle-bin, auth and
 * network controls. Never reads or writes `/api/v3/config/host` (API key, auth, ports, TLS).
 */
import type { CatalogConnectionRow } from '../../../connections/types';
import type { Services } from '../../../services';
import { num, rec, str } from '../../words';
import { getJson, ReadProblem } from '../read';
import { asBool, type DeclaredSettings, type SettingSpec, type SettingValue } from '../settings';

export type ArrSettingsApp = 'sonarr' | 'radarr';

const APP_NAME: Record<ArrSettingsApp, string> = { sonarr: 'Sonarr', radarr: 'Radarr' };

interface ConfigSection {
  id: number;
  raw: Record<string, unknown>;
}

export interface ArrSettingsState {
  mediamanagement: ConfigSection | null;
  naming: ConfigSection | null;
  downloadclient: ConfigSection | null;
  indexer: ConfigSection | null;
}

const optional = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

function parseSection(body: unknown): ConfigSection | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const r = rec(body);
  const id = num(r.id);
  if (id === null) return null;
  return { id, raw: structuredClone(r) };
}

/** Parses Sonarr or Radarr v3 config sections; any section that didn't answer is null and left out. */
export function parseArrSettings(parts: {
  mediamanagement: unknown;
  naming: unknown;
  downloadclient: unknown;
  indexer: unknown;
}): ArrSettingsState {
  return {
    mediamanagement: parseSection(parts.mediamanagement),
    naming: parseSection(parts.naming),
    downloadclient: parseSection(parts.downloadclient),
    indexer: parseSection(parts.indexer),
  };
}

export async function readArrSettings(
  app: ArrSettingsApp,
  services: Services,
  row: CatalogConnectionRow,
): Promise<ArrSettingsState> {
  const name = APP_NAME[app];
  const get = (section: string) => getJson(services, row, name, `/api/v3/config/${section}`);
  const [mediamanagement, naming, downloadclient, indexer] = await Promise.all([
    optional(get('mediamanagement')),
    optional(get('naming')),
    optional(get('downloadclient')),
    optional(get('indexer')),
  ]);
  if (mediamanagement === null && naming === null && downloadclient === null && indexer === null)
    throw new ReadProblem(`Whombat couldn’t read ${name}’s settings just now.`);
  return parseArrSettings({ mediamanagement, naming, downloadclient, indexer });
}

const boolField = (section: ConfigSection | null, key: string): boolean | undefined => {
  if (!section) return undefined;
  return typeof section.raw[key] === 'boolean' ? (section.raw[key] as boolean) : undefined;
};

const numField = (section: ConfigSection | null, key: string): number | undefined => {
  if (!section) return undefined;
  const n = num(section.raw[key]);
  return n === null ? undefined : n;
};

const strField = (section: ConfigSection | null, key: string): string | undefined => {
  if (!section) return undefined;
  return str(section.raw[key]) ?? undefined;
};

function spaceWords(v: SettingValue): string {
  const mb = Number(v);
  if (mb >= 1024 && mb % 1024 === 0) return `${mb / 1024} GB`;
  return `${mb.toLocaleString('en-GB')} MB`;
}

const PROPERS_LABEL: Record<string, string> = {
  preferAndUpgrade: 'Prefer and upgrade',
  doNotUpgrade: 'Don’t upgrade automatically',
  doNotPrefer: 'Don’t prefer',
};

const propersWords = (v: SettingValue): string => PROPERS_LABEL[String(v)] ?? String(v);

const RSS_INTERVAL_LABELS: Record<number, string> = {
  0: 'Off',
  10: 'Every 10 minutes',
  15: 'Every 15 minutes',
  30: 'Every 30 minutes',
  60: 'Every hour',
  120: 'Every 2 hours',
};

function rssWords(v: SettingValue): string {
  const m = Number(v);
  const known = RSS_INTERVAL_LABELS[m];
  if (known) return known;
  return m >= 60 && m % 60 === 0 ? `Every ${m / 60} hours` : `Every ${m} minutes`;
}

/** Builds the declared settings for Sonarr or Radarr. */
export function arrSettings(app: ArrSettingsApp): DeclaredSettings<ArrSettingsState> {
  const name = APP_NAME[app];
  const sonarr = app === 'sonarr';
  const unitPlural = sonarr ? 'episodes' : 'movies';
  const renameField = sonarr ? 'renameEpisodes' : 'renameMovies';
  const unmonitorField = sonarr
    ? 'autoUnmonitorPreviouslyDownloadedEpisodes'
    : 'autoUnmonitorPreviouslyDownloadedMovies';

  const specs: SettingSpec<ArrSettingsState>[] = [
    {
      id: 'rename_files',
      group: 'files',
      label: 'Rename files on import',
      help: `Rename imported ${unitPlural} to match your naming format. ${name} saves all naming settings together, so it stays in ${name}.`,
      kind: 'elsewhere',
      read: (s) => boolField(s.naming, renameField),
      words: (v) => (asBool(v) ? 'On' : 'Off'),
      elsewhere: (base) => `${base}/settings/mediamanagement`,
    },
    {
      id: 'hardlinks',
      group: 'files',
      label: 'Use hardlinks instead of copying',
      help: `Use hardlinks instead of copying files on the same disk. Changing it affects import space checks and links to download files, so it stays in ${name}.`,
      kind: 'elsewhere',
      read: (s) => boolField(s.mediamanagement, 'copyUsingHardlinks'),
      words: (v) => (asBool(v) ? 'On' : 'Off'),
      elsewhere: (base) => `${base}/settings/mediamanagement`,
    },
    {
      id: 'import_extra_files',
      group: 'files',
      label: 'Import extra files',
      help: `Bring along subtitles and info files from a download. Turning it off drops those files when downloads are cleaned up, so it stays in ${name}.`,
      kind: 'elsewhere',
      read: (s) => boolField(s.mediamanagement, 'importExtraFiles'),
      words: (v) => (asBool(v) ? 'On' : 'Off'),
      elsewhere: (base) => `${base}/settings/mediamanagement`,
    },
    {
      id: 'min_free_space',
      group: 'files',
      label: 'Minimum free space',
      help: `Stop importing when free space on the media disk drops below this. Lowering it can unblock upgrades that replace old files, so it stays in ${name}.`,
      kind: 'elsewhere',
      read: (s) => numField(s.mediamanagement, 'minimumFreeSpaceWhenImporting'),
      words: spaceWords,
      elsewhere: (base) => `${base}/settings/mediamanagement`,
    },
    {
      id: 'propers_and_repacks',
      group: 'files',
      label: 'Fixed releases (Propers & Repacks)',
      help: `Whether ${name} replaces an existing file when a fixed release comes out. Replacing can delete the old file, so it stays in ${name}.`,
      kind: 'elsewhere',
      read: (s) => strField(s.mediamanagement, 'downloadPropersAndRepacks'),
      words: propersWords,
      elsewhere: (base) => `${base}/settings/mediamanagement`,
    },
    {
      id: 'completed_download_handling',
      group: 'downloads',
      label: 'Import finished downloads',
      help: `Automatically import finished downloads. Turning it on can replace and permanently delete older files on upgrades, so it stays in ${name}.`,
      kind: 'elsewhere',
      read: (s) => boolField(s.downloadclient, 'enableCompletedDownloadHandling'),
      words: (v) => (asBool(v) ? 'On' : 'Off'),
      elsewhere: (base) => `${base}/settings/downloadclients`,
    },
    {
      id: 'auto_redownload_failed',
      group: 'downloads',
      label: 'Retry failed downloads',
      help: `Search for another release when a download fails. Grabbing a replacement can replace an existing file on import, so it stays in ${name}.`,
      kind: 'elsewhere',
      read: (s) => boolField(s.downloadclient, 'autoRedownloadFailed'),
      words: (v) => (asBool(v) ? 'On' : 'Off'),
      elsewhere: (base) => `${base}/settings/downloadclients`,
    },
    {
      id: 'unmonitor_deleted',
      group: 'downloads',
      label: `Stop watching deleted ${unitPlural}`,
      help: `Stop watching ${unitPlural} after their files disappear. A brief drive drop during a scan can unmonitor items permanently, so it stays in ${name}.`,
      kind: 'elsewhere',
      read: (s) => boolField(s.mediamanagement, unmonitorField),
      words: (v) => (asBool(v) ? 'On' : 'Off'),
      elsewhere: (base) => `${base}/settings/mediamanagement`,
    },
    {
      id: 'rss_sync_interval',
      group: 'downloads',
      label: 'Check for new releases',
      help: `How often ${name} checks your indexers for new uploads. ${name} saves all indexer settings together, so it stays in ${name}.`,
      kind: 'elsewhere',
      read: (s) => numField(s.indexer, 'rssSyncInterval'),
      words: rssWords,
      elsewhere: (base) => `${base}/settings/indexers`,
    },
    {
      id: 'general_and_updates',
      group: 'downloads',
      label: 'Updates and security',
      help: `Updates, sign-in and network settings stay in ${name}.`,
      kind: 'elsewhere',
      read: () => `Managed in ${name}`,
      elsewhere: (base) => `${base}/settings/general`,
    },
  ];

  return {
    name,
    url: (base) => `${base}/settings`,
    groups: [
      {
        id: 'files',
        title: 'Files and imports',
        ask: [
          `Should ${name} use hardlinks for downloads?`,
          `How much free disk space should ${name} leave?`,
        ],
      },
      {
        id: 'downloads',
        title: 'Downloads and search',
        ask: [
          `How often should ${name} check for new releases?`,
          `What happens when a download fails in ${name}?`,
        ],
      },
    ],
    specs,
    read: (services, row) => readArrSettings(app, services, row),
  };
}
