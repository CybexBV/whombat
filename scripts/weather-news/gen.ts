/**
 * `node --import tsx scripts/weather-news/gen.ts`: writes the two tables behind the place and the suggested news
 * (docs/decisions/weather-news.md) into `@whombat/core`:
 *
 * - `place-zones.ts`, from the tz database's `zone.tab` (one country per zone, the zone's city's latitude and longitude)
 *   and the links of `tzdata.zi` (older and other names of those zones, as browsers still report some: `Asia/Calcutta`,
 *   `Europe/Kiev`). Not `zone1970.tab`, which merges countries into one zone (the Netherlands into Brussels).
 * - `news-suggestions.ts`, from `news-feeds.psv` next to this script: the news sites checked to answer with a feed.
 *
 * `--zoneinfo <dir>` reads the tz files from elsewhere than `/usr/share/zoneinfo`. The tables are formatted with Biome
 * after writing.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { feedRows, newsSource, zonesSource } from './tables.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const DOMAIN = join(ROOT, 'packages/core/src/domain');
const { values } = parseArgs({ options: { zoneinfo: { type: 'string', default: '/usr/share/zoneinfo' } } });

const zones = join(DOMAIN, 'place-zones.ts');
const news = join(DOMAIN, 'news-suggestions.ts');
writeFileSync(
  zones,
  zonesSource(
    readFileSync(join(values.zoneinfo, 'zone.tab'), 'utf8'),
    readFileSync(join(values.zoneinfo, 'tzdata.zi'), 'utf8'),
  ),
);
writeFileSync(news, newsSource(feedRows(readFileSync(join(import.meta.dirname, 'news-feeds.psv'), 'utf8'))));
execFileSync('pnpm', ['exec', 'biome', 'format', '--write', zones, news], { cwd: ROOT, stdio: 'inherit' });
console.log(`weather-news gen · ${zones} · ${news}`);
