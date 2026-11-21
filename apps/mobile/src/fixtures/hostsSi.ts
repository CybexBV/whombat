/**
 * Add a server in the one-Whombat demo world (server-signin-mobile.md AP-1714). The web's fixture world
 * (`@whombat/client/hosts` `fixtures-si.ts`) wraps `createHostsFixtures`' servers, which this world doesn't have (its
 * servers are mock 4's, `assistant.ts`); this plays the same scripts on this world's servers, with the shared words,
 * and walks a job by the clock with a `hosts.install` frame on each step (`hosts.startInstall`, `hosts.getInstall`), so
 * the phone's live path is what is tried. `hosts.createEnrollment` makes the pre-approved command for the chosen level;
 * like the web's, it “runs” on the second `listEnrollments` read after it was made (web-04 is added). With
 * `EXPO_PUBLIC_WHOMBAT_SI=1`, nas-02 ran an older command and waits for you (Waiting for you, Home's “nas-02 wants
 * to be added”), and Neo's card “Add 10.100.0.40 as a server?” sits in a chat (SI-10). Jobs by what was typed (the
 * web's):
 *
 * - `10.100.0.14` becomes pve-03 (Proxmox VE 9.0 · Debian 13 · amd64); any other address a server named after it;
 * - a server's name or address (`10.100.1.11` here, `10.100.1.21` in the web's world: pve-01) updates it in place (SI-08);
 * - `10.100.0.22` reports as pve-02, which is taken: added as pve-02-2 (SI-07);
 * - the password `wrong` fails at signing in (`sign_in_failed`); a Vault key as a user other than root without a sudo
 *   password, `sudo_password_needed`;
 * - `10.20.0.5` signs in and can't reach this Whombat (`cant_reach_whombat`, the installer's last lines under More detail).
 *
 * Pure TypeScript over `Response`; every answer parses with its endpoint's schema (tested).
 */
import {
  type GuideCard,
  type HostCreateEnrollmentBody,
  type HostEnrollment,
  type HostInstall,
  HostInstallBody,
  type HostInstallErrorCode,
  type HostPendingEnrollment,
  type HostServer,
  hostInstallErrorText,
  parseHostInstallAddress,
  type RealtimeEvent,
  type VaultEntry,
} from '@whombat/core';
import { FIXTURE_SSH_PUBLIC_KEY, vaultSshDeployKey } from '@whombat/fixtures';

const PIN = 'aUyaQm1rDnw7Xo2vW9cS4hT6bJpL0eYgZfKkN3uDAxE=';
/** The agents' address of this Whombat, as the web's fixture world has it. */
const AGENTS_AT = '10.100.1.5:8443';

export interface SiFixtureDeps {
  now: () => Date;
  emit: (topic: string, event: RealtimeEvent) => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  hostsTopic: string;
  /** The viewer's own topic (`home.changed`). */
  meTopic: string;
  servers: HostServer[];
  /** Adds a server the world reports from now on (the job's or an approved enrollment's). */
  addServer: (name: string) => HostServer;
  json: (body: unknown, status?: number) => Response;
  notFound: (text: string) => Response;
  bodyOf: <T>(init: RequestInit | undefined) => Promise<T>;
  /** A server waiting from an older command, and the assistant's card (`EXPO_PUBLIC_WHOMBAT_SI=1`). */
  waiting: boolean;
}

interface Script {
  name: string;
  system: string;
  already: boolean;
  fail?: {
    at: 'connecting' | 'installing';
    code: HostInstallErrorCode;
    message: string;
    detail: string | null;
  };
}

/** A second SSH key of Mara's, for the pickers. */
const HOME_LAB_KEY = {
  ...vaultSshDeployKey,
  id: 'vlt_homelabkey',
  name: 'Home lab',
  description: 'The servers at home.',
  auth: {
    type: 'ssh_key' as const,
    keyType: 'ed25519' as const,
    publicKey: FIXTURE_SSH_PUBLIC_KEY,
    fingerprint: 'SHA256:Hk3vR0pQ7mWz1sXc9bLtY5uE2nAa8dGfJ4oKiV6yTqM',
    origin: 'imported' as const,
  },
  keyCount: 0,
  serverCount: 1,
};

export function createSiFixtures(deps: SiFixtureDeps) {
  const { now, emit, setTimer, hostsTopic, meTopic, servers, json, notFound, bodyOf } = deps;
  const jobs = new Map<string, HostInstall>();
  let seq = 0;
  /** Every enrollment: nas-02 waiting, and the commands made here (issued until they “run”). */
  const enrollments: HostPendingEnrollment[] = deps.waiting
    ? [
        {
          id: 'enr_nas02',
          state: 'pending',
          hostname: 'nas-02',
          os: 'Debian GNU/Linux 12 (bookworm)',
          address: '10.100.0.27',
          agentVersion: '0.9.2',
          requestedAt: new Date(now().getTime() - 6 * 60_000).toISOString(),
          createdAt: new Date(now().getTime() - 20 * 60_000).toISOString(),
          expiresAt: new Date(now().getTime() + 40 * 60_000).toISOString(),
          serverId: null,
          control: null,
          name: null,
        },
      ]
    : [];

  function scriptFor(body: HostInstallBody): Script {
    const parsed = parseHostInstallAddress(body.address);
    const host = parsed?.host ?? body.address;
    const fail = (
      at: 'connecting' | 'installing',
      code: HostInstallErrorCode,
      name: string | null,
      detail: string | null = null,
    ): Script['fail'] => ({
      at,
      code,
      message: hostInstallErrorText(code, { address: body.address, name, whombat: AGENTS_AT }),
      detail,
    });
    if (body.auth.kind === 'password' && body.auth.password === 'wrong')
      return { name: 'pve-03', system: '', already: false, fail: fail('connecting', 'sign_in_failed', null) };
    if (body.auth.kind === 'vault' && body.username !== 'root' && !body.auth.password)
      return { name: '', system: '', already: false, fail: fail('connecting', 'sudo_password_needed', null) };
    if (host === '10.20.0.5')
      return {
        name: 'server-5',
        system: 'Debian GNU/Linux 13 (trixie) · amd64',
        already: false,
        fail: fail(
          'installing',
          'cant_reach_whombat',
          null,
          [
            'whombat-agent: os Debian GNU/Linux 13 (trixie) · amd64',
            `install.sh: downloading https://${AGENTS_AT}/agent/whombat-agent-linux-amd64`,
            'curl: (28) Connection timed out after 20001 milliseconds',
            `install.sh: cannot reach https://${AGENTS_AT}/agent/whombat-agent-linux-amd64`,
          ].join('\n'),
        ),
      };
    // A server already here (SI-08): its name, its address in this world, or 10.100.1.21 (pve-01's in the web's).
    const known = servers.find(
      (s, i) =>
        s.id === host || `10.100.1.${10 + i}` === host || (host === '10.100.1.21' && s.id === 'pve-01'),
    );
    if (known)
      return {
        name: known.name,
        system: `${known.os ?? 'Linux'} · Debian GNU/Linux 13 (trixie) · amd64`,
        already: true,
      };
    const pve03 = host === '10.100.0.14';
    const reported = pve03
      ? 'pve-03'
      : host === '10.100.0.22'
        ? 'pve-02'
        : parsed?.hostKind === 'name'
          ? (host.split('.')[0] ?? host).toLowerCase()
          : `server-${host.split(/[.:]/).pop()}`;
    const taken = (n: string) => servers.some((s) => s.id === n || s.name === n);
    let name = body.name ?? reported;
    for (let i = 2; taken(name); i++) name = `${body.name ?? reported}-${i}`;
    const os = pve03 || host === '10.100.0.22' ? 'Proxmox VE 9.0' : 'Debian 13';
    return { name, system: pve03 ? 'Proxmox VE 9.0 · Debian 13 · amd64' : `${os} · amd64`, already: false };
  }

  function update(id: string, patch: Partial<HostInstall>) {
    const job = jobs.get(id);
    if (!job) return;
    const at = now().toISOString();
    const next = { ...job, ...patch, updatedAt: at };
    if (next.state === 'ready' || next.state === 'failed') next.finishedAt = at;
    jobs.set(id, next);
    if (patch.state && patch.state !== job.state)
      emit(hostsTopic, { type: 'hosts.install', installId: id, state: patch.state });
  }

  function start(body: HostInstallBody): HostInstall {
    seq += 1;
    const id = `ins_${String(seq).padStart(4, '0')}`;
    const at = now().toISOString();
    const job: HostInstall = {
      id,
      address: body.address,
      username: body.username,
      control: body.control,
      state: 'connecting',
      hostKey: null,
      hostKeyNew: true,
      serverId: null,
      serverName: null,
      system: null,
      already: false,
      keptKey: false,
      error: null,
      detail: null,
      startedAt: at,
      updatedAt: at,
      finishedAt: null,
    };
    jobs.set(id, job);
    const script = scriptFor(body);
    const failure = script.fail;
    const fail = (state: 'connecting' | 'installing') =>
      failure?.at === state
        ? () =>
            update(id, {
              state: 'failed',
              error: { code: failure.code, message: failure.message },
              detail: failure.detail,
            })
        : null;
    const steps: [number, () => void][] = [
      [
        900,
        () => update(id, { hostKey: { algorithm: 'ssh-ed25519', fingerprint: fingerprintOf(body.address) } }),
      ],
      [1700, fail('connecting') ?? (() => update(id, { state: 'installing' }))],
      [3600, () => update(id, { system: script.system || null })],
      [
        4300,
        fail('installing') ??
          (() => {
            const server = script.already
              ? servers.find((s) => s.name === script.name)
              : deps.addServer(script.name);
            update(id, {
              state: 'waiting',
              serverId: server?.id ?? script.name,
              serverName: script.name,
              already: script.already,
            });
          }),
      ],
      [
        6400,
        () => {
          const current = jobs.get(id);
          if (current?.state !== 'waiting') return;
          update(id, { state: 'ready', keptKey: !!body.keepKey });
          const server = servers.find((s) => s.id === current.serverId);
          if (server) emit(hostsTopic, { type: 'hosts.server', serverId: server.id, server });
          emit(meTopic, { type: 'home.changed', parts: ['things'] });
        },
      ],
    ];
    for (const [ms, fn] of steps)
      setTimer(() => {
        if (jobs.get(id)?.state !== 'failed') fn();
      }, ms);
    return job;
  }

  function installCommand(control: string): string {
    const token = `K7Q2${String(seq + 1).padStart(4, '0')}VbN8sXp4M9XD`;
    return `curl -fsSL --insecure --pinnedpubkey 'sha256//${PIN}' https://${AGENTS_AT}/install.sh | sudo sh -s -- --token ${token} --control ${control}`;
  }

  /** Pre-approved commands not run yet: enrollment id → the list reads since it was made (the web's world's rule). */
  const commands = new Map<string, number>();
  const pending = () => enrollments.filter((e) => e.state === 'pending');

  /** A pre-approved command “runs” on the second `all` list read after it was made: web-04 is added with its level. */
  function runCommands() {
    for (const [id, reads] of commands) {
      if (reads + 1 < 2) {
        commands.set(id, reads + 1);
        continue;
      }
      commands.delete(id);
      const e = enrollments.find((x) => x.id === id);
      if (e?.state !== 'issued') continue;
      let name = 'web-04';
      for (let i = 2; servers.some((s) => s.id === name); i++) name = `web-04-${i}`;
      const server = deps.addServer(name);
      Object.assign(e, {
        state: 'approved',
        hostname: 'web-04',
        os: 'Debian 13',
        address: '10.100.0.31',
        agentVersion: '0.9.2',
        requestedAt: now().toISOString(),
        serverId: server.id,
      } satisfies Partial<HostPendingEnrollment>);
      emit(hostsTopic, { type: 'hosts.server', serverId: server.id, server });
      emit(meTopic, { type: 'home.changed', parts: ['things'] });
    }
  }

  return {
    async handle(id: string, params: Record<string, string>, init: RequestInit | undefined, url: URL) {
      switch (id) {
        case 'hosts.startInstall': {
          const parsed = HostInstallBody.safeParse(await bodyOf<unknown>(init));
          if (!parsed.success)
            return json(
              { error: { code: 'validation_failed', message: 'That isn’t a server to sign in to.' } },
              400,
            );
          return json(start(parsed.data), 202);
        }
        case 'hosts.getInstall': {
          const job = jobs.get(params.installId ?? '');
          return job ? json(job) : notFound('That install is gone.');
        }
        case 'hosts.createEnrollment': {
          const body = init?.body ? await bodyOf<HostCreateEnrollmentBody>(init) : {};
          const control = body.control ?? 'full';
          seq += 1;
          const at = now();
          const enrollment: HostEnrollment = {
            id: `enr_${String(seq).padStart(4, '0')}`,
            expiresAt: new Date(at.getTime() + 3600_000).toISOString(),
            installCommand: installCommand(control),
            control,
            preApproved: true,
          };
          enrollments.push({
            id: enrollment.id,
            state: 'issued',
            hostname: null,
            os: null,
            address: null,
            agentVersion: null,
            requestedAt: null,
            createdAt: at.toISOString(),
            expiresAt: enrollment.expiresAt,
            serverId: null,
            control,
            name: body.name ?? null,
          });
          commands.set(enrollment.id, 0);
          return json(enrollment, 201);
        }
        case 'hosts.listEnrollments': {
          const state = url.searchParams.get('state') ?? 'pending';
          // The screen reads `all` to see what its command became; the waiting list's reads don't count.
          if (state === 'all') runCommands();
          return json({
            items: state === 'all' ? enrollments : enrollments.filter((e) => e.state === state),
          });
        }
        case 'hosts.approveEnrollment': {
          const e = pending().find((p) => p.id === params.enrollmentId);
          if (!e) return notFound('That server isn’t waiting any more.');
          const { name } = await bodyOf<{ name?: string }>(init);
          const server = deps.addServer(name?.trim() || e.hostname || 'server');
          Object.assign(e, { state: 'approved', serverId: server.id });
          emit(hostsTopic, { type: 'hosts.server', serverId: server.id, server });
          emit(meTopic, { type: 'home.changed', parts: ['needsYou', 'things'] });
          return json({ serverId: server.id, name: server.name });
        }
        case 'hosts.rejectEnrollment': {
          const e = pending().find((p) => p.id === params.enrollmentId);
          if (!e) return notFound('That server isn’t waiting any more.');
          e.state = 'rejected';
          emit(meTopic, { type: 'home.changed', parts: ['needsYou'] });
          return json({ ok: true });
        }
        default:
          return null;
      }
    },

    /** Mara's SSH keys in the Vault list, for the pickers. */
    vaultEntries(entries: VaultEntry[]): VaultEntry[] {
      const extra = [vaultSshDeployKey, HOME_LAB_KEY].filter((k) => !entries.some((e) => e.id === k.id));
      return [...entries, ...(extra as unknown as VaultEntry[])].sort((a, b) => a.name.localeCompare(b.name));
    },

    pendingCount: () => pending().length,

    /** Home's Needs you item for each waiting server (as Whombat's `hostsNeedsYou`). */
    needsYou() {
      return pending().map((e) => ({
        id: `hosts.enrollment:${e.id}`,
        ref: { kind: 'enrollment' as const, id: e.id },
        kind: 'enrollment' as const,
        severity: 'info' as const,
        title: `${e.hostname ?? 'A server'} wants to be added`,
        body: `${e.address ? `It asked from ${e.address}. ` : ''}Let it in to start watching it, or turn it away.`,
        at: e.requestedAt ?? now().toISOString(),
        actions: [
          {
            id: 'open',
            label: 'Review',
            style: 'primary' as const,
            kind: 'open' as const,
            href: '/things/servers?add=1',
          },
        ],
      }));
    },

    /** Neo's card from `server_add` (SI-10): opens Add a server filled in. */
    addServerCard(): GuideCard {
      return {
        kind: 'guide',
        guide: 'add_server',
        node: 'ask',
        step: null,
        title: 'Add 10.100.0.40 as a server?',
        body: 'Sign in to it once and Whombat puts its helper on it.',
        blocks: [
          {
            type: 'actions',
            actions: [
              {
                id: 'open',
                label: 'Sign in…',
                style: 'primary',
                href: '/things/servers?add=1&address=10.100.0.40&user=root&control=full',
              },
            ],
          },
        ],
        state: 'open',
        answer: null,
      } as GuideCard;
    },
  };
}

/** A made-up but well-formed host key per address; 10.100.0.14's (pve-03) is the mock's `SHA256:q3Vx…T8w`. */
function fingerprintOf(address: string): string {
  const base = 'q3VxN8pB2kRt5YwZc7LmD0fHj4GsUe1AoIiQnXvqT8w';
  if (address.trim() === '10.100.0.14') return `SHA256:${base}`;
  const turn = [...address].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 9973, 7) % base.length;
  return `SHA256:${base.slice(turn)}${base.slice(0, turn)}`;
}
