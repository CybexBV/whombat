/**
 * `api.vault.*` and `api.vaultNetworks.*` for `createFixtureFetch()` (docs/decisions/vault.md): Mara's entries from
 * `vault.ts`, with the writes a server would commit applied to an in-memory copy, each signed into the world's audit
 * chain with the neutral text (VT-51) and the owner's detail kept for the audit log (Mara is the owner of every entry).
 * Answers follow the contracts: `validation_failed` with field paths, typed refusals in `details.code`, 404 for unknown
 * ids. There is no DNS here: `.local` names resolve to 192.168.1.10, every other name to a public address.
 */
import {
  AddVaultNetworkBody,
  AddVaultSshServerBody,
  CreateVaultEntryBody,
  ERROR_STATUS,
  GiveVaultKeyBody,
  ReplaceVaultSshKeyBody,
  SetVaultKeyEnvNameBody,
  SetVaultKeyServersBody,
  SetVaultSecretBody,
  SetVaultToolBody,
  SetVaultTotpBody,
  TrustVaultSshHostKeyBody,
  UpdateVaultEntryBody,
  UpdateVaultSshServerBody,
  VAULT_ERROR_MESSAGES,
  VAULT_ERROR_STATUS,
  VAULT_LIMIT_MESSAGES,
  VAULT_TOTP_KIND_TEXT,
  type VaultErrorCode,
  type VaultErrorDetails,
} from '@whombat/core/contracts';
import type { Agent } from '@whombat/core/domain';
import { newId } from '@whombat/core/ids';
import {
  type AuditVaultDetail,
  canonicalCidr,
  defaultVaultEnvName,
  inspectVaultSshPrivateKey,
  parseVaultSshHost,
  parseVaultSshPublicKey,
  parseVaultUrl,
  sortedPorts,
  VAULT_ENTRIES_MAX,
  VAULT_NETWORKS_MAX,
  VAULT_SSH_SERVERS_MAX,
  type VaultAuditTextKind,
  type VaultAuth,
  type VaultCheckOutcome,
  type VaultEntry,
  type VaultEntryDetail,
  type VaultNetwork,
  type VaultSshServer,
  vaultAuditText,
  vaultCheckSummary,
  vaultDestinationProblem,
  vaultEntryShapeProblems,
  vaultSshCheckStatus,
  vaultSshCheckSummary,
  vaultSshDestinationProblem,
  vaultSshEntryCheck,
  vaultSshFingerprint,
} from '@whombat/core/vault';
import { mara } from './principals.js';
import { SEED_NOW } from './time.js';
import { FIXTURE_SSH_HOST_KEY, FIXTURE_SSH_PUBLIC_KEY, VAULT_ENTRIES, VAULT_NETWORKS } from './vault.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function refuse(
  code: VaultErrorCode,
  message?: string,
  details: Omit<VaultErrorDetails, 'code'> = {},
): Response {
  const status = ERROR_STATUS[VAULT_ERROR_STATUS[code]];
  return json(
    {
      error: {
        code: VAULT_ERROR_STATUS[code],
        message: message ?? VAULT_ERROR_MESSAGES[code],
        details: { code, ...details },
      },
    },
    status,
  );
}

function notFound(message = 'Not found'): Response {
  return json({ error: { code: 'not_found', message } }, 404);
}

function invalid(issues: readonly { path: readonly PropertyKey[]; message: string }[]): Response {
  const fields: Record<string, string[]> = {};
  for (const issue of issues) {
    const key = issue.path.map(String).join('.');
    fields[key] = [...(fields[key] ?? []), issue.message];
  }
  const message = issues[0]?.message ?? 'Some fields are not valid.';
  return json({ error: { code: 'validation_failed', message, fields } }, 400);
}

const now = () => SEED_NOW.toISOString();

/** The fixture resolver: `.local` names are at home, every other name is on the internet. */
function resolve(url: string): string[] {
  const parsed = parseVaultUrl(url);
  if (!parsed.ok || parsed.url.hostKind !== 'name') return [];
  return resolveHost(parsed.url.host);
}

function resolveHost(host: string): string[] {
  return host.endsWith('.local') ? ['192.168.1.10'] : ['93.184.215.14'];
}

/**
 * The SSH key “Generate a new key” gives in the fixture world (no crypto here): always the fixture key. An import of an
 * OpenSSH key gives its own public half (readable from the file); a PEM key gives the fixture key too.
 */
function fixtureSshAuth(
  source: { mode: 'generate' } | { mode: 'import'; privateKey: string },
): Extract<VaultAuth, { type: 'ssh_key' }> {
  const imported =
    source.mode === 'import' ? inspectVaultSshPrivateKey(source.privateKey) : ({ ok: false } as const);
  const publicKey = imported.ok && imported.key.publicKey ? imported.key.publicKey : FIXTURE_SSH_PUBLIC_KEY;
  const parsed = parseVaultSshPublicKey(publicKey);
  return {
    type: 'ssh_key',
    keyType: parsed?.keyType ?? 'ed25519',
    publicKey,
    fingerprint: vaultSshFingerprint(publicKey) as string,
    origin: source.mode === 'generate' ? 'generated' : 'imported',
  };
}

export interface VaultEventInput {
  id: string;
  actorId: string;
  type: string;
  kind: 'Vault' | 'Blocked';
  text: string;
  where: string | null;
  aboutId?: string;
}

/** The fixture world's Vault: Mara's entries, plus opt-in ones (`vaultShopLogin`, `vaultSshDeployKey`). */
export function createVaultWorld(extra: readonly VaultEntryDetail[] = []) {
  const entries = new Map<string, VaultEntryDetail>(
    [...VAULT_ENTRIES, ...extra].map((e) => [e.id, structuredClone(e)]),
  );
  const networks = new Map<string, VaultNetwork>(VAULT_NETWORKS.map((n) => [n.id, { ...n }]));
  /** The owner-only detail of the Vault events this world signed (`AuditEvent.vault`). */
  const details = new Map<string, AuditVaultDetail>();
  return { entries, networks, details };
}

export type VaultWorld = ReturnType<typeof createVaultWorld>;

/** The entry as YOUR ENTRIES lists it. */
function summaryOf(e: VaultEntryDetail): VaultEntry {
  const { tools: _t, toolsIgnored: _i, key: _k, recentUses: _r, ...entry } = e;
  return entry;
}

export interface VaultFetchContext {
  /** Signs an event into the world's audit chain. */
  append: (input: VaultEventInput) => { id: string };
  /** The Whombat's one agent. */
  agent: () => Agent;
}

/** Answers a `vault.*` or `vaultNetworks.*` endpoint, or null when `id` is not one. */
export async function handleVault(
  world: VaultWorld,
  ctx: VaultFetchContext,
  id: string,
  params: Record<string, string>,
  url: URL,
  req: Request,
): Promise<Response | null> {
  if (!id.startsWith('vault.') && !id.startsWith('vaultNetworks.')) return null;
  const body = async (): Promise<unknown> =>
    req.method === 'GET' || req.method === 'DELETE' ? undefined : req.json();
  const entry = params.entryId ? world.entries.get(params.entryId) : undefined;
  const agent = ctx.agent();
  const offFor = () => notFound(`This entry is off for ${agent.name}.`);

  const sign = (kind: VaultAuditTextKind, e: VaultEntryDetail, agent?: Agent): string => {
    const event = ctx.append({
      id: newId('event'),
      actorId: mara.id,
      type: `vault.${kind}`,
      kind: 'Vault',
      text: vaultAuditText(kind, { agentName: agent?.name }),
      where: 'Vault',
      ...(agent ? { aboutId: agent.id } : {}),
    });
    world.details.set(event.id, { entryId: e.id, entryName: e.name, what: null, outcome: null });
    return event.id;
  };
  const save = (next: VaultEntryDetail) => {
    const saved = {
      ...next,
      agentOn: next.key !== null,
      serverCount: next.servers.length,
      ...(next.kind === 'ssh' ? { check: vaultSshEntryCheck(next.servers) } : {}),
      updatedAt: now(),
    };
    world.entries.set(saved.id, saved);
    return saved;
  };
  const written = (next: VaultEntryDetail, kind: VaultAuditTextKind, agent?: Agent, status = 200) => {
    const saved = save(next);
    return json({ entry: saved, eventId: sign(kind, saved, agent) }, status);
  };
  const destination = (url: string) =>
    vaultDestinationProblem({ url, resolved: resolve(url), networks: [...world.networks.values()] });
  const networksAnswer = (status = 200) =>
    json(
      {
        networks: [...world.networks.values()].sort((a, b) => (a.cidr < b.cidr ? -1 : 1)),
        canManage: true,
        max: VAULT_NETWORKS_MAX,
      },
      status,
    );

  switch (id) {
    case 'vault.list': {
      const list = [...world.entries.values()].sort((a, b) => a.name.localeCompare(b.name)).map(summaryOf);
      return json({ entries: list, canAdd: list.length < VAULT_ENTRIES_MAX });
    }
    case 'vault.get': {
      if (!entry) return notFound('No such Vault entry.');
      return json({ entry });
    }
    case 'vault.create': {
      const parsed = CreateVaultEntryBody.safeParse(await body());
      if (!parsed.success) return invalid(parsed.error.issues);
      if (world.entries.size >= VAULT_ENTRIES_MAX)
        return refuse('limit_reached', VAULT_LIMIT_MESSAGES.entries, {
          limit: 'entries',
          max: VAULT_ENTRIES_MAX,
        });
      const b = parsed.data;
      if (b.url) {
        const problem = destination(b.url);
        if (problem)
          return refuse('address_not_allowed', problem.message, {
            problem: problem.code,
            ...(problem.suggestion ? { suggestion: problem.suggestion } : {}),
          });
      }
      const ssh = b.kind === 'ssh' && b.sshKey ? fixtureSshAuth(b.sshKey) : null;
      const created: VaultEntryDetail = {
        id: newId('vaultEntry'),
        name: b.name,
        description: b.description,
        kind: b.kind,
        url: b.kind === 'secret' || b.kind === 'ssh' ? null : (b.url ?? null),
        auth: ssh ?? (b.kind === 'secret' ? null : (b.auth ?? null)),
        secret: {
          set: b.secret !== undefined || ssh !== null,
          setAt: b.secret !== undefined || ssh !== null ? now() : null,
        },
        totp: b.totp !== undefined ? { set: true, setAt: now() } : { set: false, setAt: null },
        check: { status: 'unchecked', summary: '', checkedAt: null, toolCount: null },
        agentOn: false,
        serverCount: 0,
        // An `mcp` entry an older app makes moves to Connections at the next start (VLT-30); until then it says so.
        moveToConnections: b.kind === 'mcp',
        lastUsedAt: null,
        createdAt: now(),
        updatedAt: now(),
        tools: [],
        toolsIgnored: 0,
        key: null,
        recentUses: [],
        servers: [],
      };
      return written(created, 'entry.added', undefined, 201);
    }
    case 'vault.update': {
      if (!entry) return notFound('No such Vault entry.');
      const parsed = UpdateVaultEntryBody.safeParse(await body());
      if (!parsed.success) return invalid(parsed.error.issues);
      const b = parsed.data;
      const next: VaultEntryDetail = {
        ...entry,
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.description !== undefined ? { description: b.description } : {}),
        ...(b.url !== undefined ? { url: b.url } : {}),
        ...(b.auth !== undefined ? { auth: b.auth } : {}),
      };
      const problems = vaultEntryShapeProblems({ kind: next.kind, url: next.url, auth: next.auth }, 'update');
      if (problems.length)
        return invalid(problems.map((p) => ({ path: p.field.split('.'), message: p.message })));
      if (b.url !== undefined && next.url) {
        const problem = destination(next.url);
        if (problem)
          return refuse('address_not_allowed', problem.message, {
            problem: problem.code,
            ...(problem.suggestion ? { suggestion: problem.suggestion } : {}),
          });
      }
      if (next.auth?.type === 'none') next.secret = { set: false, setAt: null };
      if (b.url !== undefined || b.auth !== undefined)
        next.check = { status: 'unchecked', summary: '', checkedAt: null, toolCount: null };
      return written(next, 'entry.changed');
    }
    case 'vault.setSecret': {
      if (!entry) return notFound('No such Vault entry.');
      const parsed = SetVaultSecretBody.safeParse(await body());
      if (!parsed.success) return invalid(parsed.error.issues);
      if (entry.auth?.type === 'none') return refuse('wrong_kind', 'This entry signs in with nothing.');
      if (entry.kind === 'ssh') return refuse('wrong_kind', 'Replace an SSH key with its own buttons.');
      const username = parsed.data.username;
      const auth =
        username && entry.auth?.type === 'basic'
          ? { type: 'basic' as const, username }
          : username && entry.auth?.type === 'form'
            ? { ...entry.auth, username }
            : entry.auth;
      const problems = vaultEntryShapeProblems(
        { kind: entry.kind, url: entry.url, auth, secret: parsed.data.value },
        'update',
      );
      if (problems.length)
        return invalid(
          problems.map((p) => ({ path: p.field === 'secret' ? ['value'] : [p.field], message: p.message })),
        );
      return written({ ...entry, auth, secret: { set: true, setAt: now() } }, 'entry.secret_replaced');
    }
    case 'vault.setTotp': {
      if (!entry) return notFound('No such Vault entry.');
      const parsed = SetVaultTotpBody.safeParse(await body());
      if (!parsed.success) return invalid(parsed.error.issues);
      if (entry.kind !== 'login') return refuse('wrong_kind', VAULT_TOTP_KIND_TEXT);
      const totp = parsed.data.totp === null ? { set: false, setAt: null } : { set: true, setAt: now() };
      return written({ ...entry, totp }, 'entry.secret_replaced');
    }
    case 'vault.remove': {
      if (!entry) return notFound('No such Vault entry.');
      const eventId = sign('entry.removed', entry);
      world.entries.delete(entry.id);
      return json({ ok: true, eventId });
    }
    case 'vault.check': {
      if (!entry) return notFound('No such Vault entry.');
      if (entry.kind === 'secret' || !entry.url) return refuse('wrong_kind', 'This entry has no address.');
      if (entry.kind === 'login') return refuse('wrong_kind', 'A website login isn’t checked here.');
      if (entry.kind === 'ssh') return refuse('wrong_kind', 'Check each server of an SSH key.');
      const problem = destination(entry.url);
      const rejected = entry.id === 'vlt_printer';
      const outcome = problem ? 'not_allowed' : rejected ? 'rejected' : 'reached';
      const httpStatus = problem ? null : rejected ? 401 : entry.kind === 'http' ? 200 : null;
      const toolCount = outcome === 'reached' && entry.kind === 'mcp' ? entry.tools.length : null;
      const summary = vaultCheckSummary(outcome, {
        kind: entry.kind,
        toolCount,
        httpStatus,
        ...(problem ? { reason: problem.message } : {}),
      });
      const status = outcome === 'reached' ? ('reached' as const) : ('failing' as const);
      const saved = save({ ...entry, check: { status, summary, checkedAt: now(), toolCount } });
      return json({
        entry: saved,
        result: { outcome, status, summary, httpStatus, toolCount, checkedAt: now() },
      });
    }
    case 'vault.setTool': {
      if (!entry) return notFound('No such Vault entry.');
      if (entry.kind !== 'mcp') return refuse('wrong_kind', 'Only an MCP server has tools.');
      const parsed = SetVaultToolBody.safeParse(await body());
      if (!parsed.success) return invalid(parsed.error.issues);
      const tool = entry.tools.find((t) => t.name === params.tool);
      if (!tool) return notFound('No such tool.');
      const tools = entry.tools.map((t) =>
        t.name === tool.name ? { ...t, enabled: parsed.data.enabled, isNew: false } : t,
      );
      return written({ ...entry, tools }, 'entry.changed');
    }
    case 'vault.giveKey': {
      if (!entry) return notFound('No such Vault entry.');
      if (entry.kind === 'secret') return refuse('wrong_kind', 'Nothing uses this entry any more.');
      const parsed = GiveVaultKeyBody.safeParse(await body());
      if (!parsed.success) return invalid(parsed.error.issues);
      const servers = parsed.data.servers;
      if (servers && entry.kind !== 'ssh') return refuse('wrong_kind', 'Only an SSH key has servers.');
      if (servers?.some((id) => !entry.servers.some((s) => s.id === id))) return notFound('No such server.');
      if (parsed.data.envName !== undefined && entry.kind !== 'http')
        return refuse('wrong_kind', 'Only an API’s value is in a variable on the computer.');
      const existing = entry.key;
      if (existing) {
        const nextServers = servers === undefined ? existing.servers : servers;
        const envName = keyEnvName(entry, parsed.data.envName ?? existing.envName);
        if (sameServers(existing.servers, nextServers) && existing.envName === envName)
          return json({ entry, eventId: null });
        const key = { ...existing, servers: nextServers, envName };
        return written({ ...entry, key }, 'key.changed', agent);
      }
      const key = {
        givenAt: now(),
        servers: entry.kind === 'ssh' ? (servers ?? null) : null,
        envName: keyEnvName(entry, parsed.data.envName ?? null),
      };
      return written({ ...entry, key }, 'key.given', agent);
    }
    case 'vault.takeKey': {
      if (!entry) return notFound('No such Vault entry.');
      if (!entry.key) return offFor();
      return written({ ...entry, key: null }, 'key.taken', agent);
    }
    case 'vault.uses': {
      if (!entry) return notFound('No such Vault entry.');
      const limit = Number(url.searchParams.get('limit') ?? 20);
      return json({
        uses: entry.recentUses.slice(0, limit),
        before: null,
        hasMore: entry.recentUses.length > limit,
      });
    }
    case 'vault.generateSshKey':
    case 'vault.replaceSshKey': {
      if (!entry) return notFound('No such Vault entry.');
      if (entry.kind !== 'ssh') return refuse('wrong_kind', 'Only an SSH key entry has a key.');
      let source: { mode: 'generate' } | { mode: 'import'; privateKey: string } = { mode: 'generate' };
      if (id === 'vault.replaceSshKey') {
        const parsed = ReplaceVaultSshKeyBody.safeParse(await body());
        if (!parsed.success) return invalid(parsed.error.issues);
        source = { mode: 'import', privateKey: parsed.data.privateKey };
      }
      return written(
        { ...entry, auth: fixtureSshAuth(source), secret: { set: true, setAt: now() } },
        'entry.secret_replaced',
      );
    }
    case 'vault.addSshServer':
    case 'vault.updateSshServer': {
      if (!entry) return notFound('No such Vault entry.');
      if (entry.kind !== 'ssh') return refuse('wrong_kind', 'Only an SSH key entry has servers.');
      const adding = id === 'vault.addSshServer';
      const current = adding ? undefined : entry.servers.find((s) => s.id === params.serverId);
      if (!adding && !current) return notFound('No such server.');
      const parsed = (adding ? AddVaultSshServerBody : UpdateVaultSshServerBody).safeParse(await body());
      if (!parsed.success) return invalid(parsed.error.issues);
      const b = parsed.data;
      if (adding && entry.servers.length >= VAULT_SSH_SERVERS_MAX)
        return refuse('limit_reached', VAULT_LIMIT_MESSAGES.servers, {
          limit: 'servers',
          max: VAULT_SSH_SERVERS_MAX,
        });
      if (b.name !== undefined && entry.servers.some((s) => s.name === b.name && s.id !== current?.id))
        return refuse('server_name_taken');
      const host = b.host !== undefined ? (parseVaultSshHost(b.host)?.host ?? b.host) : current?.host;
      const port = b.port ?? current?.port ?? 22;
      const moved = adding || host !== current?.host || port !== current?.port;
      if (moved && host) {
        const problem = vaultSshDestinationProblem({
          host,
          port,
          resolved: parseVaultSshHost(host)?.hostKind === 'name' ? resolveHost(host) : [],
          networks: [...world.networks.values()],
        });
        if (problem)
          return refuse('address_not_allowed', problem.message, {
            problem: problem.code,
            ...(problem.suggestion ? { suggestion: problem.suggestion } : {}),
          });
      }
      const server: VaultSshServer = {
        id: current?.id ?? newId('vaultSshServer'),
        name: b.name ?? current?.name ?? '',
        host: host ?? '',
        port,
        username: b.username ?? current?.username ?? '',
        production: b.production ?? current?.production ?? false,
        // A kept password belongs to the server where it was checked: a new host or port forgets it.
        password: moved || !current ? { set: false, setAt: null } : current.password,
        hostKey: moved ? null : (current?.hostKey ?? null),
        seenHostKey: moved ? null : (current?.seenHostKey ?? null),
        check: moved
          ? { status: 'unchecked', outcome: null, summary: '', checkedAt: null }
          : (current?.check ?? { status: 'unchecked', outcome: null, summary: '', checkedAt: null }),
        createdAt: current?.createdAt ?? now(),
        updatedAt: now(),
      };
      const servers = adding
        ? [...entry.servers, server]
        : entry.servers.map((s) => (s.id === server.id ? server : s));
      servers.sort((x, y) => x.name.localeCompare(y.name));
      const saved = save({ ...entry, servers });
      return json(
        { entry: saved, eventId: sign('entry.changed', saved), serverId: server.id },
        adding ? 201 : 200,
      );
    }
    case 'vault.removeSshServer': {
      if (!entry) return notFound('No such Vault entry.');
      if (entry.kind !== 'ssh') return refuse('wrong_kind', 'Only an SSH key entry has servers.');
      if (!entry.servers.some((s) => s.id === params.serverId)) return notFound('No such server.');
      const servers = entry.servers.filter((s) => s.id !== params.serverId);
      // A key that listed it covers the rest; one that listed only it covers none (never all).
      const key = entry.key && {
        ...entry.key,
        servers:
          entry.key.servers === null ? null : entry.key.servers.filter((sid) => sid !== params.serverId),
      };
      return written({ ...entry, servers, key }, 'entry.changed');
    }
    case 'vault.checkSshServer':
    case 'vault.trustSshHostKey': {
      if (!entry) return notFound('No such Vault entry.');
      if (entry.kind !== 'ssh') return refuse('wrong_kind', 'Only an SSH key entry has servers.');
      const server = entry.servers.find((s) => s.id === params.serverId);
      if (!server) return notFound('No such server.');
      const trusting = id === 'vault.trustSshHostKey';
      // No network here: every server shows the fixture host key; `*.invalid` hosts can't be reached.
      const shown = server.host.endsWith('.invalid') ? null : FIXTURE_SSH_HOST_KEY;
      let hostKey = server.hostKey;
      if (trusting) {
        const parsed = TrustVaultSshHostKeyBody.safeParse(await body());
        if (!parsed.success) return invalid(parsed.error.issues);
        if (!shown || shown.fingerprint !== parsed.data.fingerprint)
          return refuse('host_key_mismatch', undefined, shown ? { hostKey: shown } : {});
        hostKey = { ...shown, trustedAt: now() };
      }
      const outcome: VaultCheckOutcome = !shown
        ? 'unreachable'
        : !hostKey
          ? 'host_key_unconfirmed'
          : hostKey.fingerprint !== shown.fingerprint
            ? 'host_key_changed'
            : 'reached';
      const summary = vaultSshCheckSummary(outcome, { username: server.username });
      const status = vaultSshCheckStatus(outcome);
      const checked: VaultSshServer = {
        ...server,
        hostKey,
        seenHostKey: shown && outcome !== 'reached' ? { ...shown, seenAt: now() } : null,
        check: { status, outcome, summary, checkedAt: now() },
        updatedAt: trusting ? now() : server.updatedAt,
      };
      const saved = save({ ...entry, servers: entry.servers.map((s) => (s.id === server.id ? checked : s)) });
      return json({
        entry: saved,
        result: { serverId: server.id, outcome, status, summary, hostKey: shown, checkedAt: now() },
        eventId: trusting ? sign('entry.changed', saved) : null,
      });
    }
    case 'vault.setKeyServers': {
      if (!entry) return notFound('No such Vault entry.');
      if (entry.kind !== 'ssh') return refuse('wrong_kind', 'Only an SSH key has servers.');
      const key = entry.key;
      if (!key) return offFor();
      const parsed = SetVaultKeyServersBody.safeParse(await body());
      if (!parsed.success) return invalid(parsed.error.issues);
      const servers = parsed.data.servers;
      if (servers?.some((sid) => !entry.servers.some((s) => s.id === sid)))
        return notFound('No such server.');
      if (sameServers(key.servers, servers)) return json({ entry, eventId: null });
      return written({ ...entry, key: { ...key, servers } }, 'key.changed', agent);
    }
    case 'vault.setKeyEnvName': {
      if (!entry) return notFound('No such Vault entry.');
      const key = entry.key;
      if (!key) return offFor();
      if (entry.kind !== 'http')
        return refuse('wrong_kind', 'Only an API’s value is in a variable on the computer.');
      const parsed = SetVaultKeyEnvNameBody.safeParse(await body());
      if (!parsed.success) return invalid(parsed.error.issues);
      if (key.envName === parsed.data.envName) return json({ entry, eventId: null });
      return written({ ...entry, key: { ...key, envName: parsed.data.envName } }, 'key.changed', agent);
    }
    case 'vaultNetworks.list':
      return networksAnswer();
    case 'vaultNetworks.add': {
      const parsed = AddVaultNetworkBody.safeParse(await body());
      if (!parsed.success) return invalid(parsed.error.issues);
      const cidr = canonicalCidr(parsed.data.cidr) as string;
      if ([...world.networks.values()].some((n) => n.cidr === cidr)) return refuse('network_listed');
      if (world.networks.size >= VAULT_NETWORKS_MAX)
        return refuse('limit_reached', VAULT_LIMIT_MESSAGES.networks, {
          limit: 'networks',
          max: VAULT_NETWORKS_MAX,
        });
      const network: VaultNetwork = {
        id: newId('vaultNetwork'),
        cidr,
        ports: sortedPorts(parsed.data.ports),
        note: parsed.data.note,
        addedBy: mara.name,
        addedAt: now(),
      };
      world.networks.set(network.id, network);
      return networksAnswer(201);
    }
    case 'vaultNetworks.remove': {
      if (!params.networkId || !world.networks.delete(params.networkId)) return notFound('No such network.');
      return networksAnswer();
    }
    default:
      return notFound(`${id} is not implemented by createFixtureFetch()`);
  }
}

/** An `http` entry's variable on the computer: the one given, else the entry's default; null for the other kinds. */
function keyEnvName(entry: VaultEntryDetail, envName: string | null): string | null {
  if (entry.kind !== 'http') return null;
  return envName ?? defaultVaultEnvName(entry.name);
}

/** Two keys' server lists are the same (null is All servers). */
function sameServers(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((id) => b.includes(id));
}

/** Every Vault endpoint the fixture fetch serves. */
export const VAULT_ENDPOINT_IDS = [
  'vault.list',
  'vault.get',
  'vault.create',
  'vault.update',
  'vault.setSecret',
  'vault.setTotp',
  'vault.remove',
  'vault.check',
  'vault.setTool',
  'vault.giveKey',
  'vault.takeKey',
  'vault.uses',
  'vault.generateSshKey',
  'vault.replaceSshKey',
  'vault.addSshServer',
  'vault.updateSshServer',
  'vault.removeSshServer',
  'vault.checkSshServer',
  'vault.trustSshHostKey',
  'vault.setKeyServers',
  'vault.setKeyEnvName',
  'vaultNetworks.list',
  'vaultNetworks.add',
  'vaultNetworks.remove',
] as const;
