/**
 * Sonarr's and Radarr's declared settings: read from `/api/v3/config/mediamanagement`, `/api/v3/config/naming`,
 * `/api/v3/config/downloadclient` and `/api/v3/config/indexer`, written back with `PUT /api/v3/config/<section>/<id>`
 * preserving every untouched field. Never reads or writes `/api/v3/config/host` (API key, auth, ports, TLS).
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
  return { id, raw: { ...r } };
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

const putSection = (sectionName: string, section: ConfigSection, patch: Record<string, unknown>) => ({
  method: 'PUT' as const,
  path: `/api/v3/config/${sectionName}/${section.id}`,
  body: { ...section.raw, ...patch },
});

const FREE_SPACE: SettingChoice[] = [
  { value: 100, label: '100 MB' },
  { value: 500, label: '500 MB' },
  { value: 1024, label: '1 GB' },
  { value: 5120, label: '5 GB' },
  { value: 10240, label: '10 GB' },
  { value: 51200, label: '50 GB' },
];

function spaceWords(v: SettingValue): string {
  const mb = Number(v);
  const known = FREE_SPACE.find((c) => c.value === mb);
  if (known) return known.label;
  if (mb >= 1024 && mb % 1024 === 0) return `${mb / 1024} GB`;
  return `${mb.toLocaleString('en-GB')} MB`;
}

const PROPERS_LABEL: Record<string, string> = {
  preferAndUpgrade: 'Prefer and upgrade',
  doNotUpgrade: 'Don’t upgrade automatically',
  doNotPrefer: 'Don’t prefer',
};

const propersWords = (v: SettingValue): string => PROPERS_LABEL[String(v)] ?? String(v);

const RSS_INTERVALS: SettingChoice[] = [
  { value: 10, label: 'Every 10 minutes' },
  { value: 15, label: 'Every 15 minutes' },
  { value: 30, label: 'Every 30 minutes' },
  { value: 60, label: 'Every hour' },
  { value: 120, label: 'Every 2 hours' },
];

function rssWords(v: SettingValue): string {
  const m = Number(v);
  const known = RSS_INTERVALS.find((c) => c.value === m);
  if (known) return known.label;
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
      help: `Rename imported ${unitPlural} to match your naming format.`,
      kind: 'switch',
      read: (s) => boolField(s.naming, renameField),
      write: (v, s) => putSection('naming', s.naming as ConfigSection, { [renameField]: asBool(v) === true }),
      sentence: (v) =>
        asBool(v)
          ? `${name} now renames ${unitPlural} when importing them.`
          : `${name} no longer renames ${unitPlural} on import.`,
    },
    {
      id: 'hardlinks',
      group: 'files',
      label: 'Use hardlinks instead of copying',
      help: 'Saves disk space and finishes imports instantly when downloads and media share a disk.',
      kind: 'switch',
      read: (s) => boolField(s.mediamanagement, 'copyUsingHardlinks'),
      write: (v, s) =>
        putSection('mediamanagement', s.mediamanagement as ConfigSection, {
          copyUsingHardlinks: asBool(v) === true,
        }),
      sentence: (v) =>
        asBool(v)
          ? `${name} now uses hardlinks instead of copying files.`
          : `${name} now copies files instead of using hardlinks.`,
    },
    {
      id: 'import_extra_files',
      group: 'files',
      label: 'Import extra files',
      help: 'Bring along subtitles and info files that come with a download.',
      kind: 'switch',
      read: (s) => boolField(s.mediamanagement, 'importExtraFiles'),
      write: (v, s) =>
        putSection('mediamanagement', s.mediamanagement as ConfigSection, {
          importExtraFiles: asBool(v) === true,
        }),
      sentence: (v) =>
        asBool(v)
          ? `${name} now imports subtitles and extra files alongside downloads.`
          : `${name} no longer imports extra files alongside downloads.`,
    },
    {
      id: 'min_free_space',
      group: 'files',
      label: 'Minimum free space',
      help: 'Stop importing when free space on the media disk drops below this.',
      kind: 'choice',
      read: (s) => numField(s.mediamanagement, 'minimumFreeSpaceWhenImporting'),
      choices: (s) =>
        withCurrent(FREE_SPACE, numField(s.mediamanagement, 'minimumFreeSpaceWhenImporting'), spaceWords),
      words: spaceWords,
      write: (v, s) =>
        putSection('mediamanagement', s.mediamanagement as ConfigSection, {
          minimumFreeSpaceWhenImporting: Number(v),
        }),
      sentence: (v) => `${name} now keeps at least ${spaceWords(v)} free before importing.`,
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
      help: 'Automatically move and rename files when your downloader finishes them.',
      kind: 'switch',
      read: (s) => boolField(s.downloadclient, 'enableCompletedDownloadHandling'),
      write: (v, s) =>
        putSection('downloadclient', s.downloadclient as ConfigSection, {
          enableCompletedDownloadHandling: asBool(v) === true,
        }),
      sentence: (v) =>
        asBool(v)
          ? `${name} now imports finished downloads automatically.`
          : `${name} no longer imports finished downloads automatically.`,
    },
    {
      id: 'auto_redownload_failed',
      group: 'downloads',
      label: 'Retry failed downloads',
      help: 'Search for another release automatically when a download fails.',
      kind: 'switch',
      read: (s) => boolField(s.downloadclient, 'autoRedownloadFailed'),
      write: (v, s) =>
        putSection('downloadclient', s.downloadclient as ConfigSection, {
          autoRedownloadFailed: asBool(v) === true,
        }),
      sentence: (v) =>
        asBool(v)
          ? `${name} now searches again when a download fails.`
          : `${name} no longer searches again automatically when a download fails.`,
    },
    {
      id: 'unmonitor_deleted',
      group: 'downloads',
      label: `Stop watching deleted ${unitPlural}`,
      help: `Don’t download ${unitPlural} again after you delete their files.`,
      kind: 'switch',
      read: (s) => boolField(s.mediamanagement, unmonitorField),
      write: (v, s) =>
        putSection('mediamanagement', s.mediamanagement as ConfigSection, {
          [unmonitorField]: asBool(v) === true,
        }),
      sentence: (v) =>
        asBool(v)
          ? `${name} now stops watching ${unitPlural} after their files are deleted.`
          : `${name} now keeps watching ${unitPlural} even if their files are deleted.`,
    },
    {
      id: 'rss_sync_interval',
      group: 'downloads',
      label: 'Check for new releases',
      help: `How often ${name} checks your indexers for new uploads.`,
      kind: 'choice',
      read: (s) => numField(s.indexer, 'rssSyncInterval'),
      choices: (s) => withCurrent(RSS_INTERVALS, numField(s.indexer, 'rssSyncInterval'), rssWords),
      words: rssWords,
      short: (v) => rssWords(v).toLowerCase(),
      write: (v, s) =>
        putSection('indexer', s.indexer as ConfigSection, {
          rssSyncInterval: Number(v),
        }),
      sentence: (v) => `${name} now checks for new releases ${rssWords(v).toLowerCase()}.`,
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
