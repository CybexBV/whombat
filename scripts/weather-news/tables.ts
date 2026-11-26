/**
 * The pure part of `scripts/weather-news/gen.ts`: the tz database's and the checked news sites' rows made into
 * `@whombat/core`'s tables.
 */

/** An ISO 6709 coordinate of `zone.tab` (`+5222+00454`, `-0745+11013`, with or without seconds) in degrees. */
export function parseIso6709(text: string): { lat: number; lon: number } {
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?([+-])(\d{3})(\d{2})(\d{2})?$/.exec(text);
  if (!m) throw new Error(`not an ISO 6709 coordinate: ${text}`);
  const part = (sign: string, d: string, mi: string, s: string | undefined) =>
    (sign === '-' ? -1 : 1) * (Number(d) + Number(mi) / 60 + Number(s ?? 0) / 3600);
  return {
    lat: part(m[1] as string, m[2] as string, m[3] as string, m[4]),
    lon: part(m[5] as string, m[6] as string, m[7] as string, m[8]),
  };
}

/** Names of standard times, not places: `CET`, `MET`, `EET`, `WET`, `EST`, `MST`, `HST`, `EST5EDT`. */
const STANDARD_TIMES = /^([CMEW]ET|[EMH]ST|[A-Z]{3}\d[A-Z]{3})$/;

const round2 = (n: number) => Math.round(n * 100) / 100 + 0;

/** `place-zones.ts` from `zone.tab` and `tzdata.zi`. */
export function zonesSource(zoneTab: string, tzdataZi: string): string {
  const places = new Map<string, [string, number, number]>();
  for (const line of zoneTab.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [country, coord, zone] = line.split('\t');
    if (!country || !coord || !zone) throw new Error(`zone.tab line: ${line}`);
    const { lat, lon } = parseIso6709(coord);
    places.set(zone, [country, round2(lat), round2(lon)]);
  }
  const version = /^# version (\S+)/m.exec(tzdataZi)?.[1] ?? 'unknown';
  const links = new Map<string, string>();
  for (const line of tzdataZi.split('\n')) {
    const m = /^L (\S+) (\S+)$/.exec(line);
    // Only names `zone.tab` doesn't list itself, for zones it does, and no standard time's name (`CET`, `EST5EDT`):
    // those say an offset, not a place.
    if (
      m &&
      places.has(m[1] as string) &&
      !places.has(m[2] as string) &&
      !STANDARD_TIMES.test(m[2] as string)
    )
      links.set(m[2] as string, m[1] as string);
  }
  const q = (s: string) => `'${s}'`;
  const placeLines = [...places.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([zone, [c, lat, lon]]) => `  ${q(zone)}: [${q(c)}, ${lat}, ${lon}],`);
  const linkLines = [...links.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, zone]) => `  ${q(name)}: ${q(zone)},`);
  return `/**
 * Written by \`node --import tsx scripts/weather-news/gen.ts\` from the tz database ${version}: don't edit it by
 * hand. What \`placeFromTimeZone\` guesses from.
 */

/** Each zone of \`zone.tab\`: its country (ISO 3166-1) and its city's latitude and longitude, to two decimals. */
export const ZONE_PLACES: Readonly<Record<string, readonly [country: string, lat: number, lon: number]>> = {
${placeLines.join('\n')}
};

/** Other names of those zones (older ones, and links such as \`US/Eastern\`), and the zone each stands for. */
export const ZONE_LINKS: Readonly<Record<string, string>> = {
${linkLines.join('\n')}
};
`;
}

/** One row of `news-feeds.psv`. */
export interface FeedRow {
  id: string;
  country: string;
  regions: string[];
  areas: string[];
  lang: string;
  name: string;
  url: string;
  checked: string;
}

/** The rows of `news-feeds.psv`, each checked for what the table may hold. */
export function feedRows(psv: string): FeedRow[] {
  const rows: FeedRow[] = [];
  const ids = new Set<string>();
  const urls = new Set<string>();
  for (const line of psv.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const f = line.split('|');
    if (f.length !== 8) throw new Error(`news-feeds.psv: 8 columns, not ${f.length}: ${line}`);
    const [id, country, regions, areas, lang, name, url, checked] = f as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const list = (s: string) => (s ? s.split(',') : []);
    const row: FeedRow = {
      id,
      country,
      regions: list(regions),
      areas: list(areas),
      lang,
      name,
      url,
      checked,
    };
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || id.startsWith('own-')) throw new Error(`id: ${id}`);
    if (!/^[A-Z]{2}$/.test(country)) throw new Error(`${id}: country ${country}`);
    for (const code of [...row.regions, ...row.areas])
      if (!new RegExp(`^${country}-[A-Z0-9]{1,3}$`).test(code)) throw new Error(`${id}: code ${code}`);
    if (row.regions.length > 0 && row.areas.length > 0) throw new Error(`${id}: regions or areas, not both`);
    if (!/^[a-z]{2,3}$/.test(lang)) throw new Error(`${id}: language ${lang}`);
    if (!url.startsWith('https://') || new URL(url).href !== url) throw new Error(`${id}: url ${url}`);
    if (!name.trim() || name.length > 80) throw new Error(`${id}: name`);
    if (ids.has(id) || urls.has(url)) throw new Error(`${id}: twice`);
    ids.add(id);
    urls.add(url);
    rows.push(row);
  }
  return rows;
}

/** `news-suggestions.ts` from the rows. */
export function newsSource(rows: FeedRow[]): string {
  const q = (s: string) => `'${s.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
  const arr = (a: string[]) => `[${a.map(q).join(', ')}]`;
  const lines = rows.map(
    (r) =>
      `  { id: ${q(r.id)}, country: ${q(r.country)}, ${r.regions.length ? `regions: ${arr(r.regions)}, ` : ''}${
        r.areas.length ? `areas: ${arr(r.areas)}, ` : ''
      }lang: ${q(r.lang)}, name: ${q(r.name)}, url: ${q(r.url)} },`,
  );
  return `/**
 * Written by \`node --import tsx scripts/weather-news/gen.ts\` from scripts/weather-news/news-feeds.psv, where each
 * site's check is noted: don't edit it by hand. The news sites Whombat suggests for a place (\`newsSuggestionsFor\`).
 */

/**
 * A suggested news site: its country (ISO 3166-1), the regions (ISO 3166-2 level 4) or areas (level 6) it is for, none
 * for the whole country, its language (ISO 639-1), its name and its feed.
 */
export interface NewsSuggestionRow {
  readonly id: string;
  readonly country: string;
  readonly regions?: readonly string[];
  readonly areas?: readonly string[];
  readonly lang: string;
  readonly name: string;
  readonly url: string;
}

export const NEWS_SUGGESTIONS: readonly NewsSuggestionRow[] = [
${lines.join('\n')}
];
`;
}
