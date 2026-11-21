/**
 * Contracts 0.121.0, the catalog for service dashboards (Whombat service-dashboards.md SD-21, SD-24, SD-S07; CT-1009):
 * Sonarr and Radarr, Overseerr shown as Seerr, and the picture paths each service page reads through its connection.
 * The discovery answers are trimmed from Sonarr 4.0.20 and Radarr 6.4.4 as they answer without a key.
 */
import { describe, expect, it } from 'vitest';
import {
  CATALOG_IDS,
  type CatalogEntry,
  callAccess,
  catalogEntry,
  catalogSignIn,
  pasteValues,
  probeMatches,
  requestAllowed,
  sensitiveReason,
} from './connections-catalog.js';

const entry = (id: string): CatalogEntry => {
  const e = catalogEntry(id);
  if (!e) throw new Error(id);
  return e;
};
const ask = (id: string, method: string, path: string, body?: unknown) => {
  const e = entry(id);
  const args = { method, path, ...(body === undefined ? {} : { body }) };
  return sensitiveReason(e, 'request', args, { access: callAccess(e, 'request', args) });
};
const allowed = (id: string, method: string, path: string) =>
  requestAllowed(entry(id), { url: 'http://10.100.0.20:8989' }, method, path);

/** The sign-in pages' heads, as Sonarr 4.0.20 and Radarr 6.4.4 answer `GET /login` without a key. */
const login = (description: string) =>
  `<!DOCTYPE html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n    <meta name="description" content="${description}" />\n`;
const answer = (body: string, status = 200) => ({ status, headers: { 'content-type': 'text/html' }, body });

describe('Sonarr and Radarr (CT-1009; SD-24, SD-S07)', () => {
  it('sits in the media chain after NZBHydra2, at home, with a key in the X-Api-Key header', () => {
    expect(CATALOG_IDS.indexOf('sonarr')).toBe(CATALOG_IDS.indexOf('nzbhydra') + 1);
    expect(CATALOG_IDS.indexOf('radarr')).toBe(CATALOG_IDS.indexOf('sonarr') + 1);
    for (const [id, name, port] of [
      ['sonarr', 'Sonarr', 8989],
      ['radarr', 'Radarr', 7878],
    ] as const) {
      const e = entry(id);
      expect([e.name, e.category, e.transport, e.baseUrl, e.handle]).toEqual([
        name,
        'home',
        'rest',
        '{url}',
        id,
      ]);
      const m = catalogSignIn(e, 'token');
      if (m?.kind !== 'token') throw new Error('token');
      expect(m.auth).toEqual({ type: 'header', name: 'X-Api-Key', template: '{secret}' });
      expect(m.steps.length).toBeGreaterThan(0);
      expect(pasteValues(m, 'API Key 0123456789abcdef0123456789abcdef Copy')).toEqual({
        secret: '0123456789abcdef0123456789abcdef',
      });
      expect(e.fields.map((f) => f.id)).toEqual(['url', 'fingerprint']);
      expect(e.fields[0]?.placeholder).toContain(`:${port}`);
      expect(e.check).toMatchObject({ kind: 'request', method: 'GET', path: '/api/v3/system/status' });
      expect(e.request?.prefixes).toEqual(['/api/v3/', '/MediaCover/']);
      expect(e.tokenUrl).toBe('{url}/settings/general');
      expect(e.docsUrl).toMatch(id === 'sonarr' ? /^https:\/\/sonarr\.tv\// : /^https:\/\/radarr\.video\//);
      expect(e.access).not.toBeNull();
      expect(e.discovery?.targets).toEqual([{ port, scheme: 'http' }]);
      for (const word of ['calendar', 'queue', 'wanted/missing', 'health', 'diskspace', '/api/v3/command'])
        expect(e.guide, `${id} ${word}`).toContain(word);
      expect(e.guide).toContain(id === 'sonarr' ? 'MissingEpisodeSearch' : 'MissingMoviesSearch');
      expect(e.guide).toContain(id === 'sonarr' ? '/api/v3/series' : '/api/v3/movie');
    }
  });

  it('never reaches the page that gives away the API key, only the API and the posters', () => {
    for (const id of ['sonarr', 'radarr']) {
      expect(allowed(id, 'GET', '/api/v3/calendar?start=2026-10-21')).toBe(true);
      expect(allowed(id, 'GET', '/MediaCover/12/poster-500.jpg')).toBe(true);
      expect(allowed(id, 'GET', '/initialize.json')).toBe(false);
      expect(allowed(id, 'GET', '/initialize.js')).toBe(false);
      expect(allowed(id, 'GET', '/login')).toBe(false);
      expect(allowed(id, 'GET', '/api/v1/system/status')).toBe(false);
    }
  });

  it('asks a person before deleting, settings, the key, updates and restarts; searches don’t', () => {
    for (const id of ['sonarr', 'radarr']) {
      expect(ask(id, 'DELETE', '/api/v3/series/12?deleteFiles=true')).not.toBeNull();
      expect(ask(id, 'PUT', '/api/v3/config/mediamanagement')).not.toBeNull();
      expect(ask(id, 'POST', '/api/v3/indexer', { name: 'x' })).not.toBeNull();
      expect(ask(id, 'POST', '/api/v3/downloadclient', { name: 'x' })).not.toBeNull();
      expect(ask(id, 'PUT', '/api/v3/rootfolder/1')).not.toBeNull();
      expect(ask(id, 'GET', '/api/v3/config/host')).not.toBeNull();
      expect(ask(id, 'POST', '/api/v3/system/restart')).not.toBeNull();
      expect(ask(id, 'POST', '/api/v3/system/shutdown')).not.toBeNull();
      expect(ask(id, 'POST', '/api/v3/command', { name: 'ApplicationUpdate' })).not.toBeNull();
      expect(ask(id, 'POST', '/api/v3/command', '{"name": "resetapikey"}')).not.toBeNull();
      const search = id === 'sonarr' ? 'MissingEpisodeSearch' : 'MissingMoviesSearch';
      expect(ask(id, 'POST', '/api/v3/command', { name: search })).toBeNull();
      expect(ask(id, 'POST', '/api/v3/command', { name: 'RssSync' })).toBeNull();
      expect(ask(id, 'GET', '/api/v3/queue?page=1')).toBeNull();
      expect(ask(id, 'GET', '/api/v3/config/naming')).toBeNull();
      expect(ask(id, 'GET', '/api/v3/health')).toBeNull();
    }
  });

  it('finds each by its sign-in page, not the other', () => {
    const sonarr = entry('sonarr').discovery?.probes[0];
    const radarr = entry('radarr').discovery?.probes[0];
    if (!sonarr || !radarr) throw new Error('probes');
    expect(sonarr.path).toBe('/login');
    expect(probeMatches(sonarr, answer(login('Sonarr')))).toBe(true);
    expect(probeMatches(radarr, answer(login('Radarr (Preview)')))).toBe(true);
    expect(probeMatches(radarr, answer(login('Radarr')))).toBe(true);
    expect(probeMatches(sonarr, answer(login('Radarr (Preview)')))).toBe(false);
    expect(probeMatches(radarr, answer(login('Sonarr')))).toBe(false);
    expect(probeMatches(sonarr, answer('', 401))).toBe(false);
    expect(probeMatches(sonarr, answer('{"status": "OK"}'))).toBe(false);
  });
});

describe('Overseerr shown as Seerr (CT-1009; SD-21)', () => {
  it('keeps its id and handle and names Seerr first', () => {
    const e = entry('overseerr');
    expect([e.id, e.handle, e.name]).toEqual(['overseerr', 'overseerr', 'Seerr']);
    expect(e.description).toBe('Movie and TV requests in Seerr, Overseerr or Jellyseerr.');
    expect(e.docsUrl).toBe('https://docs.seerr.dev/');
    expect(e.guide.indexOf('Seerr')).toBeLessThan(e.guide.indexOf('Overseerr'));
    expect(e.fields[0]?.help?.indexOf('Seerr')).toBeLessThan(e.fields[0]?.help?.indexOf('Overseerr') ?? 0);
    for (const r of e.sensitive) expect(r.reason).not.toContain('Overseerr');
  });
});

describe('picture paths inside their entries’ prefixes (CT-1009; SD-06)', () => {
  it('reads every service page’s pictures through its connection', () => {
    const cases: [string, Record<string, string>, string][] = [
      [
        'plex',
        { url: 'http://10.100.0.20:32400' },
        '/photo/:/transcode?url=%2Flibrary%2Fmetadata%2F1%2Fthumb&width=240',
      ],
      ['homeassistant', { url: 'http://10.100.0.5:8123' }, '/api/camera_proxy/camera.garden'],
      ['unifi_protect', { url: 'https://10.100.0.1' }, '/v1/cameras/66a1/snapshot'],
      ['immich', { url: 'http://10.100.0.30:2283' }, '/api/assets/0f1e/thumbnail?size=preview'],
      ['paperless', { url: 'http://10.100.0.31:8000' }, '/api/documents/42/thumb/'],
      ['sonarr', { url: 'http://10.100.0.20:8989' }, '/MediaCover/12/poster-500.jpg'],
      ['radarr', { url: 'http://10.100.0.20:7878' }, '/MediaCover/7/poster-500.jpg'],
    ];
    for (const [id, fields, path] of cases) {
      expect(requestAllowed(entry(id), fields, 'GET', path), id).toBe(true);
      expect(ask(id, 'GET', path), id).toBeNull();
    }
  });
});
