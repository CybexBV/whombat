/**
 * Found on your network for the new connections (docs/decisions/connections-more.md CM-04; desk-found.md NS-01): each
 * one's probes, as `discover.ts` runs them, against what the service itself answers without a credential (recorded
 * shapes: the status, the headers that matter, the body; Synology's and QNAP's from the vendors' documentation, NS-08),
 * the version they read, and that no other entry probing the same port takes it for itself.
 */
import { CATALOG, type CatalogEntry, catalogEntry, probeMatches, probeVersion } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { DISCOVERY_PORTS } from './discover';

interface Answer {
  status: number;
  headers?: Record<string, string>;
  body: string;
}

/** One service at one port: what it answers per path (anything else is a 404). */
const SERVICES: Record<string, { port: number; answers: Record<string, Answer>; version?: string }> = {
  unifi_access: {
    port: 12445,
    answers: {
      '/api/v1/developer/doors': {
        status: 401,
        body: '{"code":"CODE_UNAUTHORIZED","msg":"unauthorized","data":null}',
      },
    },
  },
  sabnzbd: {
    port: 8080,
    version: '4.5.1',
    answers: {
      '/api?mode=version&output=json': {
        status: 200,
        headers: { server: 'CherryPy/18.10.0', 'content-type': 'application/json' },
        body: '{"version": "4.5.1"}',
      },
    },
  },
  qbittorrent: {
    port: 8080,
    answers: {
      '/': {
        status: 200,
        body: '<!DOCTYPE html><html><head><title>qBittorrent Web UI</title></head><body></body></html>',
      },
      '/api/v2/app/version': {
        status: 403,
        body: 'Forbidden',
      },
    },
  },
  nzbhydra: {
    port: 5076,
    answers: {
      '/': {
        status: 200,
        body: '<!DOCTYPE html><html><head><title>NZBHydra 2</title></head><body></body></html>',
      },
    },
  },
  plex: {
    port: 32400,
    version: '1.41.3.9314-a0bfb8370',
    answers: {
      '/identity': {
        status: 200,
        headers: { 'x-plex-protocol': '1.0', 'content-type': 'text/xml;charset=utf-8' },
        body: '<?xml version="1.0" encoding="UTF-8"?>\n<MediaContainer size="0" claimed="1" machineIdentifier="3f9c2a7d1e" version="1.41.3.9314-a0bfb8370">\n</MediaContainer>',
      },
    },
  },
  jellyfin: {
    port: 8096,
    version: '10.10.3',
    answers: {
      '/System/Info/Public': {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"LocalAddress":"http://10.100.0.20:8096","ServerName":"Home Jellyfin","Version":"10.10.3","ProductName":"Jellyfin Server","OperatingSystem":"","Id":"8a1e2f3d4c5b6a708192a3b4c5d6e7f8","StartupWizardCompleted":true}',
      },
    },
  },
  overseerr: {
    port: 5055,
    version: '1.34.0',
    answers: {
      '/api/v1/status': {
        status: 200,
        body: '{"version":"1.34.0","commitTag":"v1.34.0","updateAvailable":false,"commitsBehind":0,"restartRequired":false}',
      },
    },
  },
  adguard: {
    port: 3000,
    answers: {
      '/login.html': {
        status: 200,
        body: '<!doctype html><html><head><meta name="theme-color" content="#67B279"><title>Login</title></head></html>',
      },
      '/control/status': { status: 401, body: 'Unauthorized' },
    },
  },
  pihole: {
    port: 80,
    answers: {
      '/api/auth': {
        status: 401,
        body: '{"session":{"valid":false,"totp":false,"sid":null,"validity":-1,"message":null},"took":0.0001}',
      },
    },
  },
  nginx_proxy_manager: {
    port: 81,
    answers: {
      '/api/': {
        status: 200,
        body: '{"status":"OK","setup":true,"version":{"major":2,"minor":12,"revision":3}}',
      },
    },
  },
  truenas: {
    port: 443,
    answers: { '/api/versions': { status: 200, body: '["v25.04.2", "v25.10.0", "current"]' } },
  },
  esphome: {
    port: 6052,
    version: '2026.6.5',
    answers: { '/version': { status: 200, body: '{"version":"2026.6.5"}' } },
  },
  pterodactyl: {
    port: 443,
    answers: {
      '/api/client': {
        status: 401,
        body: '{"errors":[{"code":"AuthenticationException","status":"401","detail":"Unauthenticated."}]}',
      },
      '/auth/login': {
        status: 200,
        body: '<html><head><script>window.SiteConfiguration = {"name":"Pterodactyl","locale":"en"};</script></head></html>',
      },
    },
  },
};

/** T3 Code's descriptor as a real 0.1.3 answered it (docs/decisions/t3code.md T3-06; capabilities shortened). */
const T3_DESCRIPTOR: Answer = {
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: '{"environmentId":"77d8990d-3960-4937-9ab5-1f65c3954ede","label":"thetitan","platform":{"os":"linux","arch":"x64","machine":"desktop"},"serverVersion":"0.1.3","orchestrationProtocolVersion":2,"capabilities":{"repositoryIdentity":true,"connectionProbe":true,"threadStop":true}}',
};
SERVICES.t3code = {
  port: 3773,
  version: '0.1.3',
  answers: { '/.well-known/t3/environment': T3_DESCRIPTOR },
};

/** What DSM 7 and QTS 5 answer before anyone signs in (NS-01): the API list entry for SYNO.API.Auth, the login XML. */
const SYNOLOGY_AUTH_INFO: Answer = {
  status: 200,
  headers: { 'content-type': 'application/json; charset="UTF-8"' },
  body: '{"data":{"SYNO.API.Auth":{"maxVersion":7,"minVersion":1,"path":"entry.cgi"}},"success":true}',
};
const QNAP_LOGIN_XML = (firmware: string): Answer => ({
  status: 200,
  headers: { 'content-type': 'text/xml' },
  body: `<?xml version="1.0" encoding="UTF-8" ?>\n<QDocRoot version="1.0"><doQuick><![CDATA[]]></doQuick><is_booting><![CDATA[0]]></is_booting><authPassed><![CDATA[0]]></authPassed><model><modelName><![CDATA[TS-464]]></modelName><internalModelName><![CDATA[TS-X64]]></internalModelName></model><firmware><version><![CDATA[${firmware}]]></version><number><![CDATA[2930]]></number><build><![CDATA[20241025]]></build></firmware><hostname><![CDATA[nas]]></hostname></QDocRoot>`,
});
SERVICES.synology = {
  port: 5001,
  answers: {
    '/webapi/query.cgi?api=SYNO.API.Info&version=1&method=query&query=SYNO.API.Auth': SYNOLOGY_AUTH_INFO,
  },
};
SERVICES.qnap = {
  port: 443,
  version: '5.2.1',
  answers: { '/cgi-bin/authLogin.cgi': QNAP_LOGIN_XML('5.2.1') },
};

const NOT_FOUND: Answer = { status: 404, body: 'Not Found' };

/** Whether every probe of `entry` matches the service's answers, and the version they read. */
function probe(
  entry: CatalogEntry,
  answers: Record<string, Answer>,
): { matched: boolean; version: string | null } {
  let version: string | null = null;
  for (const p of entry.discovery?.probes ?? []) {
    const a = answers[p.path] ?? NOT_FOUND;
    const answer = { status: a.status, headers: a.headers ?? {}, body: a.body };
    if (!probeMatches(p, answer)) return { matched: false, version: null };
    version ??= probeVersion(p, answer);
  }
  return { matched: (entry.discovery?.probes.length ?? 0) > 0, version };
}

describe('found on your network (CM-04)', () => {
  for (const [id, service] of Object.entries(SERVICES)) {
    it(`recognises ${id} on port ${service.port}, and nothing else takes it`, () => {
      const entry = catalogEntry(id) as CatalogEntry;
      expect(entry.discovery?.targets.map((t) => t.port)).toContain(service.port);
      expect(DISCOVERY_PORTS).toContain(service.port);
      const own = probe(entry, service.answers);
      expect(own.matched).toBe(true);
      if (service.version) expect(own.version).toBe(service.version);
      const others = CATALOG.filter(
        (e) => e.id !== id && e.discovery?.targets.some((t) => t.port === service.port),
      ).filter((e) => probe(e, service.answers).matched);
      expect(others.map((e) => e.id)).toEqual([]);
    });
  }

  it('reads QuTS hero’s firmware as QNAP’s version, on QNAP’s http port too (NS-01)', () => {
    const qnap = catalogEntry('qnap') as CatalogEntry;
    expect(qnap.discovery?.targets.map((t) => t.port)).toEqual([443, 8080]);
    expect(probe(qnap, { '/cgi-bin/authLogin.cgi': QNAP_LOGIN_XML('h5.2.1') })).toEqual({
      matched: true,
      version: 'h5.2.1',
    });
    expect(catalogEntry('synology')?.discovery?.targets.map((t) => t.port)).toEqual([5001, 5000]);
  });

  it('takes only T3 Code’s own descriptor for T3 Code (T3-06)', () => {
    const t3 = catalogEntry('t3code') as CatalogEntry;
    const at = (body: string, status = 200) => probe(t3, { '/.well-known/t3/environment': { status, body } });
    expect(at('{"version":"1.2.3","name":"something else"}').matched).toBe(false);
    expect(at('{"error":"not found"}', 404).matched).toBe(false);
    expect(at('<!doctype html><html><body>orchestrationProtocolVersion</body></html>').matched).toBe(false);
    expect(at(T3_DESCRIPTOR.body, 401).matched).toBe(false);
    // Nothing else served on another service's port takes it for itself.
    for (const [id, service] of Object.entries(SERVICES))
      if (id !== 't3code') expect(probe(t3, service.answers).matched, id).toBe(false);
  });

  it('sends no credential in any probe', () => {
    for (const id of Object.keys(SERVICES))
      for (const p of catalogEntry(id)?.discovery?.probes ?? [])
        expect(Object.keys(p.headers).map((h) => h.toLowerCase())).not.toContain('authorization');
  });
});
