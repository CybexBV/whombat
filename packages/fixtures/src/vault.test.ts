/**
 * The Vault in the mock world (docs/decisions/vault.md): every fixture parses against its core schema, and
 * `createFixtureFetch()` serves `api.vault.*` and `api.vaultNetworks.*` as the contracts describe.
 */
import { api } from '@whombat/core/contracts';
import {
  VaultEntryDetail,
  VaultNetwork,
  vaultDestinationProblem,
  vaultEntryMeta,
  vaultSshDestinationProblem,
  vaultSshEntryCheck,
  vaultSshFingerprint,
} from '@whombat/core/vault';
import { describe, expect, it } from 'vitest';
import { createFixtureFetch } from './fetch.js';
import { dusty, mara } from './principals.js';
import {
  FIXTURE_SSH_FINGERPRINT,
  FIXTURE_SSH_HOST_KEY,
  FIXTURE_SSH_PUBLIC_KEY,
  VAULT_ENTRIES,
  VAULT_NETWORKS,
  vaultHomeAssistant,
  vaultShopLogin,
  vaultSshDeployKey,
} from './vault.js';

const BASE = 'http://fixtures.local/api/v1';

async function call(fetchFn: typeof fetch, path: string, method = 'GET', body?: unknown) {
  const res = await fetchFn(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // biome-ignore lint/suspicious/noExplicitAny: answers are read loosely here; each test parses the contract.
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const V = '/burrows/burrow-hq/vault';

describe('vault fixtures', () => {
  it('parse, and every address is allowed by the home network list', () => {
    for (const e of VAULT_ENTRIES) {
      expect(() => VaultEntryDetail.parse(e), e.name).not.toThrow();
      if (e.url)
        expect(
          vaultDestinationProblem({
            url: e.url,
            resolved: e.url.includes('example.com') ? ['93.184.215.14'] : [],
            networks: VAULT_NETWORKS,
          }),
          e.name,
        ).toBeNull();
    }
    for (const n of VAULT_NETWORKS) expect(() => VaultNetwork.parse(n)).not.toThrow();
    expect(VAULT_ENTRIES.map((e) => [e.id, e.agentOn, e.key?.envName ?? null])).toEqual([
      ['vlt_grafana', true, 'GRAFANA'],
      ['vlt_homeassistant', true, null],
      ['vlt_printer', false, null],
      ['vlt_weather', false, null],
    ]);
    expect(vaultEntryMeta(vaultHomeAssistant, dusty.name)).toContain('on for Dusty');
  });

  it('give Home Assistant five tools, one off and one “New”', () => {
    expect(vaultHomeAssistant.tools.map((t) => [t.name, t.enabled, t.isNew])).toEqual([
      ['HassTurnOn', true, false],
      ['HassTurnOff', true, false],
      ['HassLightSet', true, false],
      ['HassCancelAllTimers', false, false],
      ['GetLiveContext', false, true],
    ]);
    expect(vaultHomeAssistant.recentUses.every((u) => u.agentId === dusty.id)).toBe(true);
    // A use is one of Mara's turns the entry reached Dusty in (CT-1244).
    expect(vaultHomeAssistant.recentUses.every((u) => u.requesterId === mara.id)).toBe(true);
  });
});

describe('createFixtureFetch() Vault endpoints', () => {
  it('reads validate against the contracts; unknown entries 404', async () => {
    const f = createFixtureFetch();
    const list = await call(f, V);
    expect(api.vault.list.response.parse(list.body).entries.map((e) => e.name)).toEqual([
      'Grafana',
      'Home Assistant',
      'Printer admin',
      'Weather API key',
    ]);
    const detail = await call(f, `${V}/vlt_homeassistant`);
    expect(api.vault.get.response.parse(detail.body).entry.key?.servers).toBeNull();
    expect(
      api.vault.uses.response.parse((await call(f, `${V}/vlt_homeassistant/uses?limit=2`)).body).hasMore,
    ).toBe(true);
    expect(
      api.vaultNetworks.list.response.parse((await call(f, '/vault/networks')).body).networks,
    ).toHaveLength(1);
    expect((await call(f, `${V}/vlt_nope`)).status).toBe(404);
  });

  it('adds an entry, refuses an unlisted home address, and signs neutral events with the owner’s detail', async () => {
    const f = createFixtureFetch();
    const refused = await call(f, V, 'POST', {
      name: 'NAS',
      kind: 'http',
      url: 'http://192.168.2.5:5000',
      auth: { type: 'basic', username: 'admin' },
      secret: 'pw',
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error.details).toEqual({
      code: 'address_not_allowed',
      problem: 'not_listed',
      suggestion: { cidr: '192.168.2.0/24', port: 5000 },
    });
    expect(refused.body.error.message).toBe(
      'That address is on your network. Add 192.168.2.0/24 port 5000 to the home network list in the Vault first.',
    );
    const bad = await call(f, V, 'POST', { name: 'X', kind: 'http', url: 'https://x.example.com' });
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.body.error.fields)).toEqual(['auth']);
    const created = await call(f, V, 'POST', {
      name: 'GitHub API',
      kind: 'http',
      url: 'https://api.github.com',
      auth: { type: 'bearer' },
      secret: 'ghp_x',
    });
    expect(created.status).toBe(201);
    const { entry, eventId } = api.vault.create.response.parse(created.body);
    expect(JSON.stringify(created.body)).not.toContain('ghp_x');
    expect(entry.secret.set).toBe(true);
    const log = await call(f, '/burrows/burrow-hq/audit?kind=vault');
    const page = api.audit.list.response.parse(log.body);
    expect(page.counts.vault).toBe(1);
    expect(page.events[0]).toMatchObject({
      id: eventId,
      kind: 'Vault',
      type: 'vault.entry.added',
      text: 'Added a private Vault entry',
      vault: { entryId: entry.id, entryName: 'GitHub API', what: null, outcome: null },
    });
  });

  it('switches an entry on and off for Dusty, and changes its variable', async () => {
    const f = createFixtureFetch();
    const given = await call(f, `${V}/vlt_printer/key`, 'PUT', {});
    const on = api.vault.giveKey.response.parse(given.body).entry;
    expect([on.agentOn, on.key?.envName]).toEqual([true, 'PRINTER_ADMIN']);
    const same = await call(f, `${V}/vlt_printer/key`, 'PUT', {});
    expect(same.body.eventId).toBeNull();
    const changed = await call(f, `${V}/vlt_printer/key/env-name`, 'PUT', { envName: 'PRINTER' });
    expect(changed.body.entry.key.envName).toBe('PRINTER');
    const secretKey = await call(f, `${V}/vlt_weather/key`, 'PUT', {});
    expect(secretKey.body.error.details.code).toBe('wrong_kind');
    const notHttp = await call(f, `${V}/vlt_homeassistant/key/env-name`, 'PUT', { envName: 'HA' });
    expect(notHttp.body.error.details.code).toBe('wrong_kind');
    const taken = await call(f, `${V}/vlt_printer/key`, 'DELETE');
    expect([taken.body.entry.agentOn, taken.body.entry.key]).toEqual([false, null]);
    expect((await call(f, `${V}/vlt_printer/key`, 'DELETE')).status).toBe(404);
    const events = api.audit.list.response.parse(
      (await call(f, '/burrows/burrow-hq/audit?kind=vault')).body,
    ).events;
    expect(events.map((e) => e.type)).toEqual(['vault.key.taken', 'vault.key.changed', 'vault.key.given']);
    expect(events.every((e) => e.text?.includes('Dusty'))).toBe(true);
    expect(events[0]?.aboutId).toBe(dusty.id);
  });

  it('checks connections, switches tools and replaces secrets', async () => {
    const f = createFixtureFetch();
    const ha = api.vault.check.response.parse((await call(f, `${V}/vlt_homeassistant/check`, 'POST')).body);
    expect(ha.result).toMatchObject({ outcome: 'reached', summary: 'Reached · 5 tools', toolCount: 5 });
    const printer = api.vault.check.response.parse((await call(f, `${V}/vlt_printer/check`, 'POST')).body);
    expect(printer.result).toMatchObject({
      outcome: 'rejected',
      status: 'failing',
      summary: 'The server rejected the secret (401).',
    });
    expect((await call(f, `${V}/vlt_weather/check`, 'POST')).status).toBe(409);
    const tool = await call(f, `${V}/vlt_homeassistant/tools/GetLiveContext`, 'PUT', { enabled: true });
    expect(
      api.vault.setTool.response.parse(tool.body).entry.tools.find((t) => t.name === 'GetLiveContext'),
    ).toMatchObject({ enabled: true, isNew: false });
    const secret = await call(f, `${V}/vlt_printer/secret`, 'PUT', { value: 'new-pw', username: 'root' });
    expect(secret.body.entry.auth).toEqual({ type: 'basic', username: 'root' });
    expect(JSON.stringify(secret.body)).not.toContain('new-pw');
    const removed = await call(f, `${V}/vlt_printer`, 'DELETE');
    expect(api.vault.remove.response.parse(removed.body).ok).toBe(true);
    expect((await call(f, `${V}/vlt_printer`)).status).toBe(404);
  });

  it('adds a website login and replaces its username (VT-D28)', async () => {
    const f = createFixtureFetch();
    const created = await call(f, V, 'POST', {
      name: 'Shop admin',
      kind: 'login',
      url: 'https://shop.example.com/admin/login',
      auth: { type: 'form', username: 'mara@example.com' },
      secret: 'correct horse',
    });
    expect(created.status).toBe(201);
    const { entry } = api.vault.create.response.parse(created.body);
    expect([entry.agentOn, entry.key]).toEqual([false, null]);
    expect(entry.totp).toEqual({ set: false, setAt: null });
    expect(JSON.stringify(created.body)).not.toContain('correct horse');
    expect((await call(f, `${V}/${entry.id}/check`, 'POST')).body.error.details.code).toBe('wrong_kind');
    const secret = await call(f, `${V}/${entry.id}/secret`, 'PUT', { value: 'new pw', username: 'ops' });
    expect(secret.body.entry.auth).toEqual({ type: 'form', username: 'ops' });
    const refused = await call(f, `${V}/${entry.id}/secret`, 'PUT', { value: 'two\nlines' });
    expect(refused.body.error.fields.value).toEqual([
      'A password can’t hold line breaks or control characters.',
    ]);
  });

  it('parses the opt-in login fixture, and keeps it out of the seeded Vault', () => {
    expect(VaultEntryDetail.parse(vaultShopLogin).kind).toBe('login');
    expect(VAULT_ENTRIES).not.toContain(vaultShopLogin);
    expect(vaultShopLogin.key?.envName).toBeNull();
  });

  it('keeps the home network list', async () => {
    const f = createFixtureFetch();
    const added = await call(f, '/vault/networks', 'POST', {
      cidr: '192.168.2.7/24',
      ports: [5000],
      note: 'NAS',
    });
    expect(added.status).toBe(201);
    expect(api.vaultNetworks.add.response.parse(added.body).networks.map((n) => n.cidr)).toEqual([
      '192.168.1.0/24',
      '192.168.2.0/24',
    ]);
    const again = await call(f, '/vault/networks', 'POST', { cidr: '192.168.2.0/24', ports: [80] });
    expect(again.body.error.details.code).toBe('network_listed');
    const wide = await call(f, '/vault/networks', 'POST', { cidr: '10.0.0.0/8', ports: [80] });
    expect(wide.status).toBe(400);
    expect(wide.body.error.fields.cidr).toEqual([
      'That network is too wide. Use a /16 or narrower (a /48 or narrower for IPv6).',
    ]);
    const nas = await call(f, V, 'POST', {
      name: 'NAS',
      kind: 'http',
      url: 'http://192.168.2.5:5000',
      auth: { type: 'basic', username: 'admin' },
      secret: 'pw',
    });
    expect(nas.status).toBe(201);
    const id = (added.body.networks as { id: string; cidr: string }[]).find(
      (n) => n.cidr === '192.168.2.0/24',
    )?.id;
    expect((await call(f, `/vault/networks/${id}`, 'DELETE')).body.networks).toHaveLength(1);
    expect((await call(f, '/vault/networks/vln_nope', 'DELETE')).status).toBe(404);
  });

  it('parses the opt-in SSH key fixture, and keeps it out of the seeded Vault (0.32.0)', () => {
    const e = VaultEntryDetail.parse(vaultSshDeployKey);
    expect(VAULT_ENTRIES).not.toContain(vaultSshDeployKey);
    expect(vaultSshFingerprint(FIXTURE_SSH_PUBLIC_KEY)).toBe(FIXTURE_SSH_FINGERPRINT);
    expect([e.serverCount, e.key?.servers]).toEqual([2, ['vss_web1']]);
    expect(vaultSshEntryCheck(e.servers)).toEqual(e.check);
    for (const srv of e.servers)
      expect(
        vaultSshDestinationProblem({
          host: srv.host,
          port: srv.port,
          resolved: ['93.184.215.14'],
          networks: [],
        }),
        srv.name,
      ).toBeNull();
  });

  it('serves an SSH key: create, servers, check, trust, key servers, replace (0.32.0)', async () => {
    const f = createFixtureFetch({ vaultEntries: [vaultSshDeployKey] });
    const created = await call(f, V, 'POST', { name: 'Ops key', kind: 'ssh', sshKey: { mode: 'generate' } });
    expect(created.status).toBe(201);
    const entry = api.vault.create.response.parse(created.body).entry;
    expect(entry).toMatchObject({ kind: 'ssh', url: null, serverCount: 0, secret: { set: true } });
    expect(entry.auth).toMatchObject({
      type: 'ssh_key',
      origin: 'generated',
      fingerprint: FIXTURE_SSH_FINGERPRINT,
    });
    expect(entry.check.summary).toBe('No servers yet');

    const added = await call(f, `${V}/${entry.id}/servers`, 'POST', {
      name: 'web-2',
      host: 'web2.example.com',
      username: 'deploy',
    });
    expect(added.status).toBe(201);
    const withServer = api.vault.addSshServer.response.parse(added.body);
    expect(withServer.entry.servers.map((x) => [x.name, x.port, x.check.status])).toEqual([
      ['web-2', 22, 'unchecked'],
    ]);
    const serverId = withServer.serverId;
    const taken = await call(f, `${V}/${entry.id}/servers`, 'POST', {
      name: 'web-2',
      host: 'x.example.com',
      username: 'a',
    });
    expect(taken.body.error.details.code).toBe('server_name_taken');
    const port = await call(f, `${V}/${entry.id}/servers`, 'POST', {
      name: 'odd',
      host: 'x.example.com',
      port: 2222,
      username: 'a',
    });
    expect(port.body.error).toMatchObject({
      message: 'Whombat reaches servers on the internet on port 22 only.',
      details: { code: 'address_not_allowed', problem: 'port_not_allowed' },
    });

    const checked = api.vault.checkSshServer.response.parse(
      (await call(f, `${V}/${entry.id}/servers/${serverId}/check`, 'POST')).body,
    );
    expect(checked.result).toMatchObject({
      outcome: 'host_key_unconfirmed',
      status: 'unchecked',
      hostKey: FIXTURE_SSH_HOST_KEY,
    });
    expect(checked.entry.servers[0]?.seenHostKey?.fingerprint).toBe(FIXTURE_SSH_HOST_KEY.fingerprint);
    const mismatch = await call(f, `${V}/${entry.id}/servers/${serverId}/trust`, 'POST', {
      fingerprint: FIXTURE_SSH_FINGERPRINT,
    });
    expect(mismatch.body.error.details).toEqual({ code: 'host_key_mismatch', hostKey: FIXTURE_SSH_HOST_KEY });
    const trusted = api.vault.trustSshHostKey.response.parse(
      (await call(f, `${V}/${entry.id}/servers/${serverId}/trust`, 'POST', FIXTURE_SSH_HOST_KEY)).body,
    );
    expect(trusted.result).toMatchObject({ outcome: 'reached', summary: 'Signed in as deploy' });
    expect(trusted.eventId).not.toBeNull();
    expect(trusted.entry.servers[0]).toMatchObject({
      seenHostKey: null,
      hostKey: { fingerprint: FIXTURE_SSH_HOST_KEY.fingerprint },
    });
    expect(trusted.entry.check).toMatchObject({ status: 'reached', summary: 'Signed in as deploy' });

    const moved = api.vault.updateSshServer.response.parse(
      (await call(f, `${V}/${entry.id}/servers/${serverId}`, 'PATCH', { host: 'web3.example.com' })).body,
    );
    expect(moved.entry.servers[0]).toMatchObject({
      host: 'web3.example.com',
      hostKey: null,
      check: { status: 'unchecked' },
    });

    const off = await call(f, `${V}/${entry.id}/key/servers`, 'PUT', { servers: null });
    expect(off.status).toBe(404);
    const given = await call(f, `${V}/${entry.id}/key`, 'PUT', { servers: [serverId] });
    expect(given.body.entry.key).toMatchObject({ servers: [serverId] });
    const all = await call(f, `${V}/${entry.id}/key/servers`, 'PUT', { servers: null });
    expect(all.body.entry.key.servers).toBeNull();
    const unknown = await call(f, `${V}/${entry.id}/key/servers`, 'PUT', { servers: ['vss_nope'] });
    expect(unknown.status).toBe(404);
    expect(
      (await call(f, `${V}/vlt_grafana/key`, 'PUT', { servers: [serverId] })).body.error.details.code,
    ).toBe('wrong_kind');

    expect((await call(f, `${V}/${entry.id}/check`, 'POST')).body.error.details.code).toBe('wrong_kind');
    expect((await call(f, `${V}/${entry.id}/secret`, 'PUT', { value: 'x' })).body.error.details.code).toBe(
      'wrong_kind',
    );
    expect(
      (await call(f, `${V}/vlt_grafana/servers`, 'POST', { name: 'a', host: 'a.example.com', username: 'a' }))
        .body.error.details.code,
    ).toBe('wrong_kind');
    const generated = await call(f, `${V}/${entry.id}/ssh-key/generate`, 'POST');
    expect(generated.body.entry.auth.origin).toBe('generated');
    const bad = await call(f, `${V}/${entry.id}/ssh-key`, 'PUT', { privateKey: FIXTURE_SSH_PUBLIC_KEY });
    expect(bad.body.error.fields.privateKey).toEqual([
      'That’s the public key. Paste the private key: the file without .pub.',
    ]);

    const removed = await call(f, `${V}/${entry.id}/servers/${serverId}`, 'DELETE');
    expect(removed.body.entry.servers).toEqual([]);
    expect(removed.body.entry.serverCount).toBe(0);
    // Dusty's key covered web-1 only: without it, it covers no server (never all of them).
    const web1 = await call(f, `${V}/vlt_deploykey/servers/vss_web1`, 'DELETE');
    expect(web1.body.entry.key.servers).toEqual([]);
  });
});
