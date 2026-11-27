/**
 * `node --import tsx scripts/weather-news/check.ts [--file <psv>] [--only <id,…>] [--unchecked] [--write]`: reads each
 * feed of `news-feeds.psv` (or another file of its rows) the way a Whombat reads it, and says whether it may be a
 * suggestion (docs/decisions/weather-news.md): answered over https from its own address, without a redirect, within
 * 1 MiB, an RSS or Atom feed whose newest item is recent. Whombat's own User-Agent, one feed at a time.
 *
 * `--unchecked` reads only the rows whose last column is empty; `--write` puts what was found in the last column of
 * each row that passed (`2026-11-27: rss 20 items, newest 2026-11-27 07:19Z`) and leaves the others as they are.
 * Exits 1 when any row failed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parseFeed } from '../../apps/server/src/news/feeds.ts';
import { FEED_ACCEPT } from '../../apps/server/src/news/reader.ts';
import { FEED_COLUMNS } from './tables.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const { values } = parseArgs({
  options: {
    file: { type: 'string', default: join(import.meta.dirname, 'news-feeds.psv') },
    only: { type: 'string' },
    unchecked: { type: 'boolean', default: false },
    write: { type: 'boolean', default: false },
    'max-age-days': { type: 'string', default: '14' },
  },
});

const version = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
const USER_AGENT = `Whombat/${version} (+https://whombat.com)`;
const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_AGE_MS = Number(values['max-age-days']) * 86_400_000;

/** One GET as the box sends it: no redirect followed, at most 1 MiB. */
function get(url: string): Promise<{ status: number; location?: string; body: string }> {
  return new Promise((done, fail) => {
    const req = https.get(url, { headers: { 'user-agent': USER_AGENT, accept: FEED_ACCEPT } }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BYTES) {
          req.destroy();
          fail(new Error(`larger than ${MAX_BYTES} bytes`));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () =>
        done({
          status: res.statusCode ?? 0,
          ...(res.headers.location && { location: res.headers.location }),
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
      res.on('error', fail);
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('timeout')));
    req.on('error', fail);
  });
}

const minute = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')}Z`;

/** What a feed's check found, as the last column writes it, or why it can't be a suggestion. */
async function check(
  url: string,
  now: number,
): Promise<{ ok: true; note: string } | { ok: false; why: string }> {
  let res: Awaited<ReturnType<typeof get>>;
  try {
    res = await get(url);
  } catch (err) {
    return { ok: false, why: String(err instanceof Error ? err.message : err) };
  }
  if (res.status !== 200)
    return { ok: false, why: `HTTP ${res.status}${res.location ? ` → ${res.location}` : ''}` };
  const feed = parseFeed(res.body, url, now);
  if (!feed) return { ok: false, why: 'not RSS or Atom' };
  const count = (res.body.match(feed.kind === 'atom' ? /<entry[\s>]/g : /<item[\s>]/g) ?? []).length;
  const newest = feed.items[0]?.at;
  if (!newest) return { ok: false, why: `${feed.kind}, no item with a title, link and date` };
  if (now - newest > MAX_AGE_MS)
    return { ok: false, why: `${feed.kind}, newest ${minute(newest)}: not recent` };
  const day = new Date(now).toISOString().slice(0, 10);
  return { ok: true, note: `${day}: ${feed.kind} ${count} items, newest ${minute(newest)}` };
}

const only = values.only ? new Set(values.only.split(',')) : null;
const lines = readFileSync(values.file, 'utf8').split('\n');
let failed = 0;
let passed = 0;
for (const [i, line] of lines.entries()) {
  if (!line.trim() || line.startsWith('#')) continue;
  const f = line.split('|');
  if (f.length !== FEED_COLUMNS) throw new Error(`${FEED_COLUMNS} columns, not ${f.length}: ${line}`);
  const id = f[0] as string;
  const url = f[8] as string;
  if (only && !only.has(id)) continue;
  if (values.unchecked && f[9]) continue;
  const found = await check(url, Date.now());
  if (found.ok) {
    passed++;
    console.log(`ok    ${id}  ${found.note}`);
    if (values.write) lines[i] = [...f.slice(0, 9), found.note].join('|');
  } else {
    failed++;
    console.log(`FAIL  ${id}  ${url}  ${found.why}`);
  }
}
if (values.write) writeFileSync(values.file, lines.join('\n'));
console.log(`weather-news check · ${passed} passed · ${failed} failed`);
process.exitCode = failed ? 1 : 0;
