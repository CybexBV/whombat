/**
 * Add a server by signing in once in the fixture world (Whombat `server-signin.md`, app `server-signin-web.md`
 * AP-1689): `hosts.startInstall` starts a scripted job that `hosts.getInstall` walks one state per two reads —
 * connecting → installing → waiting → ready — and the server joins the fleet when it reports. Deterministic (reads,
 * not a clock). What an address or password plays:
 *
 * - `10.100.0.14`: pve-03 (mock: Proxmox VE 9.0 · Debian 13 · amd64); any other address: a Debian server named after it.
 * - `10.100.1.21` (pve-01's address) or `pve-01`: already added, its agent updated in place (SI-08).
 * - `10.100.0.22`: its host name is pve-02, which is taken, so it is added as `pve-02-2` (SI-07).
 * - the password `wrong`: “the user name or password isn’t right” (`sign_in_failed`).
 * - `10.20.0.5`: signs in, then can't reach this Whombat (`cant_reach_whombat`, with the installer's last lines).
 * - a Vault key as a user other than root with no sudo password: `sudo_password_needed`.
 *
 * `hosts.createEnrollment` with a `control` makes the pre-approved command (`--control <level>`); the newest such command
 * “runs” on its second read of every enrollment (`state=all`): web-04 is added with it. Wraps `createHostsFixtures`' routes (one line there).
 */
import {
  type HostControlLevel,
  type HostInstall,
  HostInstallBody,
  type HostInstallErrorCode,
  type HostPendingEnrollment,
  type HostServer,
  type HostServerDetail,
  hostInstallErrorText,
  parseHostInstallAddress,
} from '@whombat/core/domain';
import type { HostsFixtureAnswer, HostsFixtureRequest, HostsFixtureWorld } from './fixtures';
import { hostControlLevelOf } from './install';

type Handle = (req: HostsFixtureRequest) => HostsFixtureAnswer | null;

/** Reads a state is held for before the next one. */
const HOLD = 2;
const WHOMBAT_AGENTS = '10.100.1.5:8443';

/** A Windows PC's PowerShell line as the hosts service makes it (its installer's SHA-256 is made up). */
function windowsLine(token: string, control: string): string {
  return (
    `$u='https://${WHOMBAT_AGENTS}';$s='3f9a1c27d84e6b05a2c9e7f1d3b8a6045e2c7d9f1a3b5c8e0d2f4a6b8c0e1f3a';` +
    "if($PSVersionTable.PSEdition -eq 'Core'){$o=@{SkipCertificateCheck=$true}}" +
    'else{$o=@{};[Net.ServicePointManager]::SecurityProtocol=3072;[Net.ServicePointManager]::ServerCertificateValidationCallback={$true}};' +
    '$b=(Invoke-WebRequest -UseBasicParsing @o "$u/install.ps1").RawContentStream.ToArray();' +
    "if((-join([Security.Cryptography.SHA256]::Create().ComputeHash($b)|%{$_.ToString('x2')})) -ne $s)" +
    "{'whombat-agent: the installer did not match. Copy the line from Whombat again.'}" +
    `else{&([scriptblock]::Create([Text.Encoding]::UTF8.GetString($b))) -Origin $u -Hub 'https://${WHOMBAT_AGENTS}' -Token '${token}' -Control '${control}'}`
  );
}
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** A well-formed SHA256 fingerprint per address (the mock's for pve-03). */
function fingerprint(address: string): string {
  if (address === '10.100.0.14') return 'SHA256:q3VxR8mKp2dLw7NfYc4ZtH1sJb9GeA6uQo5XiV0nT8w';
  let h = 7;
  for (const c of address) h = (h * 31 + c.charCodeAt(0)) % 2147483647;
  let out = '';
  for (let i = 0; i < 43; i++) {
    h = (h * 16807) % 2147483647;
    out += B64[h % 64];
  }
  return `SHA256:${out}`;
}

interface Step {
  patch: Partial<HostInstall>;
  /** What reaching this step does to the world (the server joins the fleet). */
  effect?: () => void;
}

interface Job {
  view: HostInstall;
  steps: Step[];
  reads: number;
  /** The last step applied (the first is the answer to the start). */
  at: number;
}

function fail(
  code: HostInstallErrorCode,
  message: string,
  detail: string | null = null,
): Partial<HostInstall> {
  return { state: 'failed', error: { code, message }, detail };
}

export function withSi(base: Handle, ctx: { world: HostsFixtureWorld; now: number }): Handle {
  const { world, now } = ctx;
  const jobs = new Map<string, Job>();
  /** Pre-approved commands not run yet: enrollment id → its level and the list reads since it was made. */
  const commands = new Map<string, { control: HostControlLevel; reads: number }>();
  let seq = 0;
  const at = (n: number) => new Date(now + n * 1_000).toISOString();

  const nameTaken = (name: string) => world.servers.some((s) => s.id === name || s.name === name);
  const freeName = (name: string) => {
    if (!nameTaken(name)) return name;
    for (let n = 2; ; n++) if (!nameTaken(`${name}-${n}`)) return `${name}-${n}`;
  };

  /** A server that reports to this Whombat from now on (the-falcon's row and page under its own name). */
  function addServer(id: string, os: string, address: string, status: HostServer['status']) {
    const template = world.servers.find((s) => s.id === 'the-falcon') as HostServer;
    const row: HostServer = {
      ...template,
      id,
      name: id,
      status,
      statusNote: null,
      os,
      cpuPct: null,
      guests: [],
      temperature: null,
    };
    const at = world.servers.findIndex((s) => s.id === id);
    if (at >= 0) world.servers[at] = row;
    else world.servers.push(row);
    const page = world.details.get('the-falcon');
    if (page && !world.details.has(id))
      world.details.set(id, {
        ...page,
        server: { ...page.server, id, address },
      } as HostServerDetail);
    if (!world.guests.has(id)) world.guests.set(id, []);
  }

  /** The script an install plays, from what was typed. */
  function script(body: HostInstallBody, hostKey: HostInstall['hostKey']): Step[] {
    const target = parseHostInstallAddress(body.address);
    const host = target?.host ?? body.address;
    const signIn: Step = { patch: { state: 'connecting' } };
    const signedIn: Partial<HostInstall> = { hostKey, hostKeyNew: true };
    if (body.auth.kind === 'password' && body.auth.password === 'wrong')
      return [
        signIn,
        { patch: fail('sign_in_failed', hostInstallErrorText('sign_in_failed', { address: body.address })) },
      ];
    if (body.auth.kind === 'vault' && body.username !== 'root' && !body.auth.password)
      return [
        signIn,
        {
          patch: {
            ...signedIn,
            ...fail(
              'sudo_password_needed',
              hostInstallErrorText('sudo_password_needed', { address: body.address }),
            ),
          },
        },
      ];
    if (host === '10.20.0.5')
      return [
        signIn,
        { patch: { state: 'installing', ...signedIn, system: 'Debian GNU/Linux 13 (trixie) · amd64' } },
        {
          patch: fail(
            'cant_reach_whombat',
            hostInstallErrorText('cant_reach_whombat', { address: body.address, whombat: WHOMBAT_AGENTS }),
            [
              'whombat-agent: os Debian GNU/Linux 13 (trixie) · amd64',
              `install.sh: downloading https://${WHOMBAT_AGENTS}/agent/whombat-agent-linux-amd64`,
              'curl: (28) Connection timed out after 20001 milliseconds',
              `install.sh: cannot reach https://${WHOMBAT_AGENTS}/agent/whombat-agent-linux-amd64`,
            ].join('\n'),
          ),
        },
      ];
    // A reinstalled server (connect-in-chat.md): its key isn't the one the Vault trusted, and one Vault server pins it.
    if (host === '10.20.0.6')
      return [
        signIn,
        {
          patch: {
            hostKey,
            hostKeyNew: false,
            pins: [{ entryId: 'vlt_fixture_servers', serverId: 'vss_fixture_reinstalled' }],
            ...fail('host_key_changed', hostInstallErrorText('host_key_changed', { address: body.address })),
          },
        },
      ];
    const existing = world.servers.find(
      (s) => s.id === host || world.details.get(s.id)?.server.address === host,
    );
    if (existing) {
      const system = `${existing.os ?? 'Linux'} · Debian GNU/Linux 13 (trixie) · amd64`;
      return [
        signIn,
        { patch: { state: 'installing', ...signedIn, system } },
        {
          patch: { state: 'waiting', serverId: existing.id, serverName: existing.name, already: true },
        },
        { patch: { state: 'ready', keptKey: !!body.keepKey } },
      ];
    }
    const pve03 = host === '10.100.0.14';
    const reported = pve03
      ? 'pve-03'
      : host === '10.100.0.22'
        ? 'pve-02'
        : /^[\d.]+$/.test(host)
          ? `server-${host.split('.').pop()}`
          : (host.split('.')[0] as string).toLowerCase();
    const name = freeName(body.name ?? reported);
    const os = pve03 || host === '10.100.0.22' ? 'Proxmox VE 9.0' : 'Debian 13';
    const system = pve03 ? 'Proxmox VE 9.0 · Debian 13 · amd64' : `${os} · amd64`;
    return [
      signIn,
      { patch: { state: 'installing', ...signedIn, system } },
      {
        patch: { state: 'waiting', serverId: name, serverName: name },
        effect: () => addServer(name, os, host, 'pending'),
      },
      {
        patch: { state: 'ready', keptKey: !!body.keepKey },
        effect: () => addServer(name, os, host, 'ok'),
      },
    ];
  }

  function advance(job: Job): HostInstall {
    job.reads++;
    const target = Math.min(Math.floor(job.reads / HOLD), job.steps.length - 1);
    for (let i = job.at + 1; i <= target; i++) {
      const s = job.steps[i] as Step;
      s.effect?.();
      job.view = { ...job.view, ...s.patch, updatedAt: at(i * 4) };
      if (job.view.state === 'ready' || job.view.state === 'failed')
        job.view = { ...job.view, finishedAt: job.view.updatedAt };
    }
    job.at = Math.max(job.at, target);
    return job.view;
  }

  return (req) => {
    const seg = req.path.split('/').filter(Boolean).map(decodeURIComponent);
    const route = `${req.method} ${seg.map((s, i) => (i % 2 === 1 ? ':' : s)).join('/')}`;
    if (route === 'POST installs') {
      const parsed = HostInstallBody.safeParse(req.body);
      if (!parsed.success)
        return {
          status: 400,
          body: { error: { code: 'bad_request', message: 'That isn’t a sign-in Whombat can use.' } },
        };
      const body = parsed.data;
      if (!parseHostInstallAddress(body.address))
        return {
          status: 400,
          body: {
            error: {
              code: 'bad_request',
              message: 'That isn’t an address.',
              details: { code: 'not_allowed' },
            },
          },
        };
      const id = `inst_si${++seq}`;
      const view: HostInstall = {
        id,
        address: body.address,
        username: body.username,
        control: body.control,
        state: 'connecting',
        hostKey: null,
        hostKeyNew: false,
        serverId: null,
        serverName: null,
        system: null,
        already: false,
        keptKey: false,
        error: null,
        detail: null,
        startedAt: at(0),
        updatedAt: at(0),
        finishedAt: null,
      };
      const hostKey = { algorithm: 'ssh-ed25519', fingerprint: fingerprint(body.address) };
      jobs.set(id, { view, steps: script(body, hostKey), reads: 0, at: 0 });
      return { status: 202, body: view };
    }
    if (route === 'GET installs/:') {
      const job = jobs.get(seg[1] ?? '');
      if (!job)
        return {
          status: 404,
          body: {
            error: {
              code: 'not_found',
              message: 'That isn’t running any more.',
              details: { code: 'not_found' },
            },
          },
        };
      return { status: 200, body: advance(job) };
    }
    if (route === 'POST enrollments') {
      const control = hostControlLevelOf(req.body.control);
      const answer = base(req);
      if (!control || answer?.status !== 201) return answer;
      const made = answer.body as { id: string; installCommand: string };
      // Only the newest command “runs” (the one copied last).
      commands.clear();
      commands.set(made.id, { control, reads: 0 });
      const e = world.enrollments.find((x) => x.id === made.id);
      if (e) e.control = control;
      const token = `${made.id.replace(/\W/g, '').slice(-2).toUpperCase()}K7-Q2M9`;
      return {
        ...answer,
        body: {
          ...made,
          installCommand: `curl -fsSL --pinnedpubkey 'sha256//Xq3mVb9kQe2s0hWc8oT4uY1pZr7aLd5nJf6gBi0Ck2E=' https://${WHOMBAT_AGENTS}/install.sh | sudo sh -s -- --token ${token} --control ${control}`,
          installCommandWindows: windowsLine(token, control),
          control,
          preApproved: true,
        },
      };
    }
    if (route === 'GET enrollments' && req.query.state === 'all') {
      // The newest pre-approved command “runs” on the second read of the whole list: web-04 is added with its level.
      for (const [id, c] of commands) {
        if (++c.reads < 2) continue;
        commands.delete(id);
        const e = world.enrollments.find((x) => x.id === id);
        if (e?.state !== 'issued') continue;
        const name = freeName('web-04');
        Object.assign(e, {
          state: 'approved',
          hostname: 'web-04',
          os: 'Debian 13',
          address: '10.100.0.31',
          agentVersion: '0.17.0',
          requestedAt: at(0),
          serverId: name,
        } satisfies Partial<HostPendingEnrollment>);
        addServer(name, 'Debian 13', '10.100.0.31', 'ok');
      }
    }
    return base(req);
  };
}
