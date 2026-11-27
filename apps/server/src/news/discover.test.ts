/**
 * Adding a news source by an address of any kind it knows (docs/decisions/weather-news.md): a YouTube channel, a
 * subreddit, a Mastodon or Bluesky account, an Apple podcast, a GitHub project, a page or a feed. The sites answer from
 * saved fixtures through the open-data seam; nothing reaches the network.
 */
import { readFileSync } from 'node:fs';
import { NEWS_WORDS } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { type OpenDataAnswer, type OpenDataOptions, useOpenDataForTests } from '../lib/open-data';
import type { Services } from '../services';
import { findFeed, newsAddressOf, YOUTUBE_PAGE_MAX, youtubeChannelId } from './discover';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const ok = (body: string): OpenDataAnswer => ({ status: 200, headers: {}, body: Buffer.from(body) });
const redirect = (location: string, status = 302): OpenDataAnswer => ({
  status,
  headers: { location },
  body: Buffer.alloc(0),
});
const NOT_FOUND: OpenDataAnswer = { status: 404, headers: {}, body: Buffer.alloc(0) };

const CHANNEL = 'UCa1b2c3d4e5f6g7h8i9j0kL';
const CHANNEL_FEED = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL}`;

function world(answers: Record<string, OpenDataAnswer>) {
  const asked: { url: string; headers: Record<string, string>; options: OpenDataOptions | undefined }[] = [];
  const services = {
    clock: () => new Date('2026-11-26T08:00:00Z'),
    log: { warn: () => undefined },
    config: { NODE_ENV: 'test' },
  } as unknown as Services;
  useOpenDataForTests(services, async (url, headers, options) => {
    asked.push({ url, headers, options });
    return answers[url] ?? NOT_FOUND;
  });
  return { services, asked };
}

/** The words a refusal shows under the address field, or null when it was added. */
const refusal = (services: Services, typed: string) =>
  findFeed(services, typed).then(
    () => null,
    (err: { extra: { fields?: { url?: string[] } } }) => err.extra.fields?.url?.[0] ?? 'no url field',
  );

describe('what an address stands for', () => {
  it('knows YouTube channels, subreddits, Bluesky, Apple podcasts, GitHub projects and Mastodon accounts', () => {
    expect(newsAddressOf(`https://www.youtube.com/channel/${CHANNEL}/videos`)).toEqual({
      kind: 'youtube',
      feed: CHANNEL_FEED,
    });
    for (const page of ['@examplechannel', 'c/ExampleChannel', 'user/examplechannel'])
      expect(newsAddressOf(`https://m.youtube.com/${page}/featured`)).toEqual({
        kind: 'youtube',
        channelPage: `https://www.youtube.com/${page}`,
      });
    expect(newsAddressOf('https://www.youtube.com/playlist?list=PLabcdefghij123')).toMatchObject({
      feed: 'https://www.youtube.com/feeds/videos.xml?playlist_id=PLabcdefghij123',
    });
    for (const sub of ['https://old.reddit.com/r/examplenews/', 'https://reddit.com/r/examplenews/top?t=day'])
      expect(newsAddressOf(sub)).toEqual({
        kind: 'reddit',
        feed: 'https://www.reddit.com/r/examplenews/.rss',
      });
    expect(newsAddressOf('https://bsky.app/profile/newsroom.example.com')).toEqual({
      kind: 'bluesky',
      feed: 'https://bsky.app/profile/newsroom.example.com/rss',
    });
    expect(
      newsAddressOf('https://podcasts.apple.com/nl/podcast/example-morning/id1234567890?i=1000'),
    ).toEqual({
      kind: 'podcast',
      appleId: '1234567890',
    });
    expect(newsAddressOf('https://github.com/example-org/example-app.git')).toEqual({
      kind: 'github',
      feed: 'https://github.com/example-org/example-app/releases.atom',
    });
    expect(newsAddressOf('https://social.example.com/@townhall')).toEqual({
      kind: 'mastodon',
      feed: 'https://social.example.com/@townhall.rss',
      orPage: true,
    });
  });

  it('leaves pages, feeds and GitHub’s own pages to be looked at as they are', () => {
    for (const address of [
      'https://news.example.com/',
      CHANNEL_FEED,
      'https://www.youtube.com/watch?v=AbCdEfGhIjK',
      'https://www.reddit.com/r/examplenews/.rss',
      'https://github.com/features/actions',
      'https://github.com/example-org/example-app/releases.atom',
      'https://social.example.com/@townhall/117625790631441803',
    ])
      expect([address, newsAddressOf(address)]).toEqual([address, null]);
  });

  it('finds a YouTube channel’s id in its page: its feed first, its own id before others', () => {
    expect(youtubeChannelId(fixture('youtube-channel.html'))).toBe(CHANNEL);
    const bare = `<script>{"externalId":"${CHANNEL}","channelId":"UCzyxwvutsrqponmlkjihgfe"}</script>`;
    expect(youtubeChannelId(bare)).toBe(CHANNEL);
    expect(youtubeChannelId('<html>no channel</html>')).toBeNull();
  });
});

describe('adding a source of each kind', () => {
  it('reads a YouTube channel’s page once, past the cookie question, for its feed', async () => {
    const w = world({
      'https://www.youtube.com/@examplechannel': redirect('https://www.youtube.com/examplechannel', 303),
      'https://www.youtube.com/examplechannel': ok(fixture('youtube-channel.html')),
      [CHANNEL_FEED]: ok(fixture('youtube-videos.xml')),
    });
    expect(await findFeed(w.services, 'youtube.com/@examplechannel')).toEqual({
      url: CHANNEL_FEED,
      name: 'Example Channel',
      kind: 'youtube',
    });
    const page = w.asked.find((a) => a.url === 'https://www.youtube.com/examplechannel');
    expect(page?.headers.cookie).toMatch(/SOCS=/);
    expect(page?.options?.keepFirst).toBe(YOUTUBE_PAGE_MAX);
    expect(w.asked.every((a) => a.headers['user-agent']?.startsWith('Whombat/'))).toBe(true);
  });

  it('takes a channel’s address straight to its feed, and says so when YouTube asks about cookies', async () => {
    const w = world({
      [CHANNEL_FEED]: ok(fixture('youtube-videos.xml')),
      'https://www.youtube.com/@elsewhere': redirect('https://consent.youtube.com/m?continue=x'),
    });
    expect(await findFeed(w.services, `https://www.youtube.com/channel/${CHANNEL}`)).toMatchObject({
      url: CHANNEL_FEED,
      kind: 'youtube',
    });
    expect(w.asked.map((a) => a.url)).toEqual([CHANNEL_FEED]);
    expect(await refusal(w.services, 'https://www.youtube.com/@elsewhere')).toBe(NEWS_WORDS.unreachable);
    expect(w.asked.some((a) => a.url.includes('consent.'))).toBe(false);
  });

  it('reads a subreddit, a GitHub project’s releases and a Bluesky account by their feeds', async () => {
    const w = world({
      'https://www.reddit.com/r/examplenews/.rss': ok(fixture('reddit.atom')),
      'https://github.com/example-org/example-app/releases.atom': ok(fixture('github-releases.atom')),
      'https://bsky.app/profile/newsroom.example.com/rss': redirect(
        'https://bsky.app/profile/did:plc:abcdefghijklmnopqrstuvwx/rss',
      ),
      'https://bsky.app/profile/did:plc:abcdefghijklmnopqrstuvwx/rss': ok(fixture('bluesky.rss')),
    });
    expect(await findFeed(w.services, 'https://www.reddit.com/r/examplenews')).toEqual({
      url: 'https://www.reddit.com/r/examplenews/.rss',
      name: 'Example News',
      kind: 'reddit',
    });
    expect(await findFeed(w.services, 'github.com/example-org/example-app')).toMatchObject({
      url: 'https://github.com/example-org/example-app/releases.atom',
      kind: 'github',
    });
    // Bluesky answers a handle's feed from the account's lasting id; that address is the one kept.
    expect(await findFeed(w.services, 'https://bsky.app/profile/newsroom.example.com')).toMatchObject({
      url: 'https://bsky.app/profile/did:plc:abcdefghijklmnopqrstuvwx/rss',
      kind: 'bluesky',
    });
  });

  it('reads a Mastodon account’s posts, and a page that only looks like one by the feed it names', async () => {
    const w = world({
      'https://social.example.com/@townhall.rss': ok(fixture('mastodon.rss')),
      'https://blog.example.com/@writer': ok(
        '<html><head><title>Writer</title><link rel="alternate" type="application/rss+xml" href="/feed/@writer"></head></html>',
      ),
      'https://blog.example.com/feed/@writer': ok(
        fixture('reddit.atom').replace('Example News', 'Writer’s blog'),
      ),
    });
    expect(await findFeed(w.services, 'https://social.example.com/@townhall')).toEqual({
      url: 'https://social.example.com/@townhall.rss',
      name: 'Example Town Hall',
      kind: 'mastodon',
    });
    expect(await findFeed(w.services, 'https://blog.example.com/@writer')).toEqual({
      url: 'https://blog.example.com/feed/@writer',
      name: 'Writer’s blog',
      kind: 'site',
    });
  });

  it('asks Apple for a podcast’s feed, reads it over https, and knows a podcast by its audio', async () => {
    const w = world({
      'https://itunes.apple.com/lookup?id=1234567890': ok(fixture('itunes-lookup.json')),
      'https://feeds.example.com/morning/podcast.xml': ok(fixture('podcast.rss')),
      'https://radio.example.com/': ok(
        '<html><head><link rel="alternate" type="application/rss+xml" href="https://feeds.example.com/morning/podcast.xml"></head></html>',
      ),
    });
    expect(
      await findFeed(w.services, 'https://podcasts.apple.com/us/podcast/example-morning/id1234567890'),
    ).toEqual({
      url: 'https://feeds.example.com/morning/podcast.xml',
      name: 'Example Morning',
      kind: 'podcast',
    });
    expect(w.asked.some((a) => a.url.startsWith('http:'))).toBe(false);
    expect(await findFeed(w.services, 'radio.example.com')).toMatchObject({ kind: 'podcast' });
  });

  it('refuses a channel, subreddit or podcast that isn’t there, in the person’s words', async () => {
    const w = world({
      'https://itunes.apple.com/lookup?id=999': ok('{"resultCount":0,"results":[]}'),
      'https://www.reddit.com/r/busy/.rss': { status: 429, headers: {}, body: Buffer.alloc(0) },
    });
    expect(await refusal(w.services, 'https://www.youtube.com/@nobody')).toBe(NEWS_WORDS.notFeed);
    expect(await refusal(w.services, 'https://www.reddit.com/r/nothere')).toBe(NEWS_WORDS.notFeed);
    expect(await refusal(w.services, 'https://www.reddit.com/r/busy')).toBe(NEWS_WORDS.unreachable);
    expect(await refusal(w.services, 'https://podcasts.apple.com/us/podcast/x/id999')).toBe(
      NEWS_WORDS.notFeed,
    );
  });
});
