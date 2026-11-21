/**
 * Add a server by signing in once (docs/decisions/server-signin.md SI-01…SI-11; server-signin-server.md SI-S01…): the
 * install job behind `hosts.startInstall` / `hosts.getInstall` (contracts 0.85.0, CT-375). Whombat's server signs in to
 * the server over SSH with the person's password or Vault key, becomes root (directly, `sudo -n`, or `sudo -S` with the
 * password on stdin), only then makes a pre-approved enrollment with the chosen control level, streams the hosts
 * service's installer into a `mktemp` file and runs it with the token on stdin, reads its result line, sets the hub's
 * switches for a server that was already there, optionally leaves a Vault key on it (SI-09), signs the change as the
 * person and waits for the agent's first report.
 *
 * Jobs live in this process's memory (like console tickets, ONE-DH19) until 30 minutes after they finish; each step is
 * a `hosts.install` frame on `hosts:<burrowId>`. The password and the token are held only while the SSH steps run,
 * travel on stdin, never on a command line, and are never logged, signed, recorded or put in `detail` (SI-03).
 */
import { randomBytes } from 'node:crypto';
import {
  HOST_MACOS_MIN_MAJOR,
  type HostControlLevel,
  type HostInstall,
  type HostInstallBody,
  newId,
  type VaultSshHostKey,
  type VaultSshKeyAuth,
} from '@whombat/core';
import type { Client } from 'ssh2';
import type { z } from 'zod';
import type { CommandDef } from '../commit/types';
import { iso } from '../lib/time';
import type { Services } from '../services';
import { type ExecOutcome, SshFailure, sshCloseGraceMs, sshExec } from '../vault/ssh';
import { addVaultSshServer, createVaultSshEntry, trustVaultSshHostKey } from '../vault/ssh-commands';
import { generateSshKey, type SshKeyForms, sshKeyForms } from '../vault/ssh-keys';
import { openSshSignIn } from '../vault/ssh-signin';
import { serverRows, type VaultEntryRow, vaultPinnedServers, vaultPins } from '../vault/store';
import { HOSTS_API, type HostsActor, HostsError, HostsUnavailable, seg } from './client';
import { committed, recordHostsChange } from './commands';
import { hostsErrorText } from './errors';
import {
  agentsPlace,
  hubSwitches,
  INSTALL_TEXT,
  type InstallFailure,
  installChangeText,
  installDetail,
  installFailureText,
  installProblemOf,
  type MacFacts,
  macMajor,
  parseInstallOutput,
  parseMacFacts,
  repointChangeText,
  systemLine,
} from './install-words';
import { arr, obj, str } from './map';
import { screenStep } from './screen';
import { HOSTS_TEXT, type HostsService, hostsFor } from './service';

/** How long each part may take (tests shorten them through `installsFor(services).timing`). */
export interface InstallTiming {
  /** Connect and sign in (SI-02: the Vault's 30 s). */
  signInMs: number;
  /** One short command (`id`, `sudo`, `mktemp`, `cat`, `rm`, the key). */
  stepMs: number;
  /** The installer (150 s). */
  installMs: number;
  /** The agent's first report (60 s). */
  reportMs: number;
  /** How often the fleet is read while waiting for it (its events wake the wait sooner). */
  pollMs: number;
  /** How long a finished job stays readable. */
  keepMs: number;
}

export const INSTALL_TIMING: Readonly<InstallTiming> = {
  signInMs: 30_000,
  stepMs: 20_000,
  installMs: 150_000,
  reportMs: 60_000,
  pollMs: 2_000,
  keepMs: 30 * 60_000,
};

/** Jobs running at once (SI-S08): per person, per box. */
export const INSTALL_RUNNING_MAX = { person: 2, box: 4 } as const;

/** Leaves a public key in the signed-in user's `~/.ssh/authorized_keys` once (SI-09); the key line comes on stdin. */
export const KEEP_KEY_COMMAND =
  'sh -c \'umask 077; d="$HOME/.ssh"; f="$d/authorized_keys"; mkdir -p "$d" && chmod 700 "$d" && touch "$f" && chmod 600 "$f" && IFS= read -r k && { grep -qxF "$k" "$f" || { [ -s "$f" ] && [ -n "$(tail -c 1 "$f")" ] && echo >> "$f"; printf "%s\\n" "$k" >> "$f"; }; }\'';

/** How the installer becomes root (SI-S05). */
export type RootWay = 'root' | 'sudo' | 'sudo_password';

/** On a Mac (macos-servers.md): its macOS, then who is at its screen, one per line. */
export const MAC_FACTS_COMMAND = 'sw_vers -productVersion; stat -f %Su /dev/console';

/**
 * The command that runs the installer as root; its stdin is `password\ntoken\n` (`sudo -S`) or `token\n`. Without a
 * level (a repoint, BF-S36) the agent's own lock stays exactly as it is.
 */
export function installCommand(way: RootWay, file: string, control: HostControlLevel | null): string {
  const run = `sh ${file} --token -${control ? ` --control ${control}` : ''}`;
  if (way === 'root') return run;
  // `-k`: sudo always reads its password line, so the token is never taken for it, nor the password for the token.
  return way === 'sudo' ? `sudo -n ${run}` : `sudo -k -S -p '' ${run}`;
}

/** A path `mktemp` printed that is safe on a command line. */
const TEMP_PATH = /^\/[A-Za-z0-9._/-]{1,200}$/;
/** An OpenSSH public key line, safe as one line of stdin. */
const PUBLIC_KEY = /^[a-z0-9@.-]+ [A-Za-z0-9+/]+=*$/;

const NO_FORMS: SshKeyForms = { forms: [], aligned: [], longest: 0 };

/** An install stopped on purpose, with its failure and (for the installer) what it printed. */
class InstallStop extends Error {
  constructor(
    readonly failure: InstallFailure,
    readonly detail: string | null = null,
  ) {
    super(failure.code);
    this.name = 'InstallStop';
  }
}

/** What the route checked and prepared before the job starts. */
export interface InstallPlan {
  burrowId: string;
  personId: string;
  actor: HostsActor;
  body: HostInstallBody;
  /** The host (canonical) and port the address names. */
  host: string;
  port: number;
  /** A Vault key to sign in with (opened by the route), its entry and name. */
  privateKey: string | null;
  keyEntryId: string | null;
  /** SI-09: the person's own SSH entry to leave on the server, or a new one to make. */
  keep: { entry: VaultEntryRow } | { create: true } | null;
  /**
   * Pointing an agent that is there at this Whombat (backup-file.md BF-15, BF-S36): the installer runs without
   * `--control` (the agent's own lock stays), the hub's switches stay as they are, and it is signed as a repoint.
   */
  repoint?: boolean;
}

interface Job {
  view: HostInstall;
  burrowId: string;
  personId: string;
  actor: HostsActor;
  host: string;
  port: number;
  /** Held while the SSH steps run; dropped at the end (SI-03). */
  secrets: { password: string | null; token: string | null; privateKey: string | null };
  /**
   * On a Mac whose user at the screen is the one Whombat signed in as: that user and the password, held until the agent's
   * first report to go to the Mac as its screen account (macos-servers.md), then dropped. Never stored.
   */
  screen: { user: string; password: string } | null;
  /** What Whombat read of a Mac; null on Linux. */
  mac: MacFacts | null;
  withKey: boolean;
  agents: string | null;
  /** The enrollment the job made, and whether an agent took its token (`added`, or `waiting` for the person). */
  enrollment: { id: string; claimed: boolean } | null;
  finished: number | null;
  /** Settles when the job has ended (ready or failed). */
  done: Promise<void>;
}

const keyOf = (host: string, port: number) => `${host.toLowerCase()}:${port}`;

type Exec = (command: string, stdin?: string, timeoutMs?: number) => Promise<ExecOutcome>;

export class HostInstalls {
  readonly #jobs = new Map<string, Job>();
  timing: InstallTiming = { ...INSTALL_TIMING };

  constructor(private readonly services: Services) {}

  get #hosts(): HostsService {
    return hostsFor(this.services);
  }

  /** Jobs that haven't finished. */
  running(): { personId: string; key: string }[] {
    this.#sweep();
    return [...this.#jobs.values()]
      .filter((j) => j.finished === null)
      .map((j) => ({ personId: j.personId, key: keyOf(j.host, j.port) }));
  }

  /** Why another job can't start now (SI-S08), or null. */
  limit(personId: string, host: string, port: number): 'same' | 'person' | 'box' | null {
    const running = this.running();
    const key = keyOf(host, port);
    if (running.some((j) => j.personId === personId && j.key === key)) return 'same';
    if (running.filter((j) => j.personId === personId).length >= INSTALL_RUNNING_MAX.person) return 'person';
    if (running.length >= INSTALL_RUNNING_MAX.box) return 'box';
    return null;
  }

  /** The person's own job, or null (another person's is as missing as one that ended long ago, SI-S09). */
  get(id: string, personId: string): HostInstall | null {
    this.#sweep();
    const job = this.#jobs.get(id);
    return job && job.personId === personId ? { ...job.view } : null;
  }

  /** Starts a job and runs it in the background; answers it as it starts (`connecting`). */
  start(plan: InstallPlan): HostInstall {
    this.#sweep();
    const now = iso(this.services.clock());
    const job: Job = {
      view: {
        id: `hin_${randomBytes(12).toString('base64url')}`,
        address: plan.body.address.trim(),
        username: plan.body.username,
        control: plan.body.control,
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
        startedAt: now,
        updatedAt: now,
        finishedAt: null,
      },
      burrowId: plan.burrowId,
      personId: plan.personId,
      actor: plan.actor,
      host: plan.host,
      port: plan.port,
      secrets: { password: plan.body.auth.password ?? null, token: null, privateKey: plan.privateKey },
      screen: null,
      mac: null,
      withKey: plan.body.auth.kind === 'vault',
      agents: null,
      enrollment: null,
      finished: null,
      done: Promise.resolve(),
    };
    // From here the job holds the password, and only until its SSH steps end (SI-03).
    if (plan.body.auth.password !== undefined) delete (plan.body.auth as { password?: string }).password;
    this.#jobs.set(job.view.id, job);
    job.done = this.#run(job, plan).catch((err: unknown) =>
      this.services.log.warn({ err: err instanceof Error ? err.name : 'error' }, 'hosts: an install broke'),
    );
    return { ...job.view };
  }

  /** The job as it ended (a repoint waits for it, BF-S36); null when there is no such job. */
  async finished(id: string): Promise<HostInstall | null> {
    const job = this.#jobs.get(id);
    if (!job) return null;
    await job.done;
    return { ...job.view };
  }

  #sweep(): void {
    const now = Date.now();
    for (const [id, job] of this.#jobs)
      if (job.finished !== null && now - job.finished > this.timing.keepMs) this.#jobs.delete(id);
  }

  /** A step: the view changes and a `hosts.install` frame goes out (on the burrow's topic; the person reads the job). */
  #update(job: Job, change: Partial<HostInstall>): void {
    job.view = { ...job.view, ...change, updatedAt: iso(this.services.clock()) };
    if (job.view.state === 'ready' || job.view.state === 'failed') {
      job.view.finishedAt ??= job.view.updatedAt;
      job.finished ??= Date.now();
    }
    this.services.bus.publish({
      topic: `hosts:${job.burrowId}`,
      event: { type: 'hosts.install', installId: job.view.id, state: job.view.state },
      eventId: null,
      at: job.view.updatedAt,
      outboxId: null,
    });
  }

  #fail(job: Job, failure: InstallFailure, detail: string | null): void {
    const message = installFailureText(failure, {
      address: job.view.address,
      name: job.view.serverName,
      agents: job.agents,
      withKey: job.withKey,
      mac: job.mac,
    });
    this.#update(job, { state: 'failed', error: { code: failure.code, message }, detail });
  }

  /** Drops every secret the job held for the SSH steps (SI-03); a Mac's screen account goes after its first report. */
  #forget(job: Job): void {
    job.secrets.password = null;
    job.secrets.token = null;
    job.secrets.privateKey = null;
  }

  async #run(job: Job, plan: InstallPlan): Promise<void> {
    let client: Client | null = null;
    let temp: string | null = null;
    let signedIn = false;
    let pinned = false;
    const forms =
      plan.keyEntryId && plan.privateKey ? sshKeyForms(plan.keyEntryId, plan.privateKey) : NO_FORMS;
    plan.privateKey = null;
    const exec: Exec = (command, stdin, timeoutMs = this.timing.stepMs) => {
      if (!client) return Promise.reject(new SshFailure('unreachable'));
      return sshExec(
        client,
        {
          command,
          stdin,
          timeoutMs,
          maxOutput: 64 * 1024,
          openMs: 15_000,
          graceMs: sshCloseGraceMs(this.services),
        },
        forms,
      );
    };
    try {
      // 1. Sign in (SI-02, SI-04, SI-05).
      const pins = await vaultPins(this.services.db, job.burrowId, job.personId, job.host, job.port);
      pinned = pins.length > 0;
      const opened = await openSshSignIn(
        this.services,
        { host: job.host, port: job.port, username: job.view.username },
        job.secrets.privateKey
          ? { privateKey: job.secrets.privateKey }
          : { password: job.secrets.password ?? '' },
        { pins, deadlineMs: this.timing.signInMs },
      );
      job.secrets.privateKey = null;
      client = opened.client;
      signedIn = true;
      this.#update(job, { hostKey: opened.hostKey, hostKeyNew: opened.hostKeyNew });

      // 2. Root.
      const way = await this.#root(job, exec);
      // A Mac's screen account: the password Whombat signed in with, when that user is at the screen and only
      // with Full control (the screen goes with the host-shell switch).
      if (
        job.mac?.consoleUser &&
        job.mac.consoleUser === job.view.username &&
        job.secrets.password &&
        job.view.control === 'full' &&
        !plan.repoint
      )
        job.screen = { user: job.view.username, password: job.secrets.password };

      // 3. Enroll, only now that Whombat is in (SI-07): pre-approved, with the level and the name.
      this.#update(job, { state: 'installing' });
      const made = obj(
        await this.#hosts.call<unknown>({
          method: 'POST',
          path: `${HOSTS_API}/enrollments`,
          body: {
            approve: true,
            control: job.view.control,
            ...(plan.body.name ? { name: plan.body.name } : {}),
          },
          actor: job.actor,
        }),
      );
      const token = str(made.token);
      if (!token) throw new InstallStop({ code: 'failed', message: HOSTS_TEXT.down });
      job.secrets.token = token;
      job.enrollment = str(made.id) ? { id: str(made.id) as string, claimed: false } : null;
      job.agents = agentsPlace(str(made.agent_url));
      const script = await this.#hosts.text({
        path: `${HOSTS_API}/agent-install.sh`,
        actor: job.actor,
        timeoutMs: 30_000,
      });

      // 4. Install: the script in a mktemp file, run as root with the token (and sudo's password) on stdin.
      const mk = await exec('mktemp');
      const path = mk.stdout.trim();
      if (mk.exitCode !== 0 || !TEMP_PATH.test(path)) throw new InstallStop({ code: 'failed' });
      temp = path;
      const wrote = await exec(`cat > ${path}`, script);
      if (wrote.exitCode !== 0) throw new InstallStop({ code: 'failed' });
      const since = Date.now();
      const stdin = way === 'sudo_password' ? `${job.secrets.password ?? ''}\n${token}\n` : `${token}\n`;
      const out = await exec(
        installCommand(way, path, plan.repoint ? null : job.view.control),
        stdin,
        this.timing.installMs,
      );
      await exec(`rm -f ${path}`).catch(() => null);
      temp = null;
      const { result, os } = parseInstallOutput(out.withheld ? '' : out.stdout);
      if (job.enrollment && (result?.kind === 'added' || result?.kind === 'waiting'))
        job.enrollment.claimed = true;
      this.#update(job, { system: systemLine(os) });
      const detail = () =>
        out.withheld ? null : installDetail(out, [job.secrets.password, job.secrets.token]);
      if (result?.kind === 'waiting')
        throw new InstallStop({ code: 'failed', message: INSTALL_TEXT.waiting(job.view.address) }, detail());
      if (!result || result.kind === 'other-whombat' || out.exitCode !== 0)
        throw new InstallStop({ code: installProblemOf(out) }, detail());
      await this.#withdraw(job);
      const serverId = result.id;
      const already = result.kind === 'kept';
      this.#update(job, { serverId, serverName: serverId, already });

      // 5. Already there (SI-08): its switches on Whombat's side, exactly the level (a repoint leaves them).
      if (already && !plan.repoint)
        await this.#hosts.call({
          method: 'PATCH',
          path: `${HOSTS_API}/servers/${seg(serverId)}`,
          body: { remote_control: hubSwitches(job.view.control) },
          actor: job.actor,
        });
      this.#hosts.forget('fleet', 'agents');

      // 6. A Vault key left on it (SI-09), when asked; a problem there doesn't undo the install (SI-S10).
      if (plan.keep) {
        const kept = await this.#keepKey(job, plan.keep, exec, serverId, opened.hostKey).catch(
          (err: unknown) => {
            this.services.log.warn(
              { err: err instanceof Error ? err.name : 'error' },
              'hosts: the Vault key wasn’t left on the server',
            );
            return false;
          },
        );
        if (kept) this.#update(job, { keptKey: true });
      }

      // 7. Done with the server: close, forget the password and the token.
      client.end();
      client = null;
      this.#forget(job);

      // 8. Signed as the person, for Done recently; then the first report.
      await this.#sign(job, serverId, already, str(made.id), plan.repoint === true);
      this.#update(job, { state: 'waiting' });
      const name = await this.#firstReport(serverId, since);
      if (name) this.#update(job, { state: 'ready', serverName: name });
      else this.#fail(job, { code: 'timed_out', installed: true }, null);
      if (name && job.screen) await this.#screenAccount(job, serverId);
    } catch (err) {
      // The key a server showed before Whombat stopped (a refused sign-in, a key the Vault doesn't trust).
      if (err instanceof SshFailure && err.hostKey && !job.view.hostKey)
        job.view = {
          ...job.view,
          hostKey: err.hostKey,
          hostKeyNew: err.reason !== 'host_key_changed' && !pinned,
        };
      const { failure, detail } = this.#failureOf(job, err, signedIn);
      // A changed key: which of the person's Vault servers trust the old one, so “Trust the new one” can trust it again.
      if (failure.code === 'host_key_changed')
        job.view = {
          ...job.view,
          pins: await vaultPinnedServers(
            this.services.db,
            job.burrowId,
            job.personId,
            job.host,
            job.port,
          ).catch(() => []),
        };
      await this.#withdraw(job);
      this.#fail(job, failure, detail);
    } finally {
      if (client && temp) await exec(`rm -f ${temp}`).catch(() => null);
      (client as Client | null)?.end();
      this.#forget(job);
      job.screen = null;
      await this.#withdraw(job);
    }
  }

  /**
   * Gives a Mac its screen account: the agent signs in to Screen Sharing with it and keeps it only if that
   * worked. Screen Sharing off, a refused password or the switch off are not install problems: the Mac's page says what
   * is missing. The password goes to the Mac and is dropped here either way.
   */
  async #screenAccount(job: Job, serverId: string): Promise<void> {
    const account = job.screen;
    job.screen = null;
    if (!account) return;
    const result = await screenStep(this.#hosts, serverId, { op: 'account.set', account }, job.actor).catch(
      (err: unknown) => ({ ok: false, code: err instanceof HostsError ? err.code : 'unavailable' }),
    );
    if (!result.ok)
      this.services.log.info({ code: result.code ?? 'failed' }, 'hosts: the Mac’s screen account wasn’t set');
  }

  /**
   * A pre-approved token no agent took (the agent was already there, another Whombat's, or the install failed) is
   * turned away at once instead of staying good for an hour (SI-S13).
   */
  async #withdraw(job: Job): Promise<void> {
    const e = job.enrollment;
    if (!e || e.claimed) return;
    job.enrollment = null;
    await this.#hosts
      .call({
        method: 'POST',
        path: `${HOSTS_API}/enrollments/${seg(e.id)}/reject`,
        body: {},
        actor: job.actor,
      })
      .catch(() => null);
  }

  /**
   * Root directly, through `sudo -n`, or through `sudo -S` with the password on stdin (SI-02, SI-S05), on Linux or on a
   * Mac with macOS 13 or later (sudo works the same there).
   */
  async #root(job: Job, exec: Exec): Promise<RootWay> {
    const who = await exec('id -u && uname -s');
    const [uid, kernel] = who.stdout.trim().split(/\s+/);
    if (who.exitCode !== 0 || !uid || !/^\d+$/.test(uid) || (kernel !== 'Linux' && kernel !== 'Darwin'))
      throw new InstallStop({ code: 'unsupported' });
    if (kernel === 'Darwin') {
      job.mac = parseMacFacts((await exec(MAC_FACTS_COMMAND)).stdout);
      const major = macMajor(job.mac.version);
      if (major === null || major < HOST_MACOS_MIN_MAJOR) throw new InstallStop({ code: 'unsupported' });
    }
    if (uid === '0') return 'root';
    const quiet = await exec('sudo -n true');
    if (quiet.exitCode === 0) return 'sudo';
    const refused = (text: string) =>
      /not in the sudoers|may not run sudo|not allowed to (?:run|execute)/i.test(text);
    if (quiet.exitCode === 127 || refused(quiet.stderr)) throw new InstallStop({ code: 'sudo_refused' });
    const password = job.secrets.password;
    if (!password) throw new InstallStop({ code: 'sudo_password_needed' });
    const asked = await exec("sudo -k -S -p '' true", `${password}\n`);
    if (asked.exitCode === 0) return 'sudo_password';
    // The sign-in's own password not taken by sudo: this user may not use it (rootpw, targetpw, not listed).
    if (refused(asked.stderr) || !job.withKey) throw new InstallStop({ code: 'sudo_refused' });
    throw new InstallStop({
      code: 'sudo_password_needed',
      message: INSTALL_TEXT.sudoPasswordNotTaken(job.view.address),
    });
  }

  /** SI-09: the key in `authorized_keys`, then the server in the Vault entry with the key it showed, trusted. */
  async #keepKey(
    job: Job,
    keep: NonNullable<InstallPlan['keep']>,
    exec: Exec,
    serverName: string,
    hostKey: VaultSshHostKey,
  ): Promise<boolean> {
    const as = { burrowId: job.burrowId, actorId: job.personId };
    const commit = <S extends z.ZodType, R>(cmd: CommandDef<S, R>, input: z.input<S>) =>
      this.services.pipeline.commit(cmd, input, as).then(committed);
    // A new key is made first and kept only once the server has it.
    const made = 'create' in keep ? { entryId: newId('vaultEntry') } : null;
    const material = made ? generateSshKey(made.entryId) : null;
    const entryId = made?.entryId ?? ('entry' in keep ? keep.entry.id : '');
    const publicKey =
      material?.auth.publicKey ??
      ('entry' in keep ? ((keep.entry.auth as VaultSshKeyAuth | null)?.publicKey ?? '') : '');
    if (!entryId || !PUBLIC_KEY.test(publicKey)) return false;
    const left = await exec(KEEP_KEY_COMMAND, `${publicKey}\n`);
    if (left.exitCode !== 0) return false;
    if (material)
      await commit(createVaultSshEntry, {
        entryId,
        name: 'Servers',
        description: 'Signs Whombat in to the servers it added.',
        privateKey: material.privateKey,
        auth: material.auth,
      });
    const servers = await serverRows(this.services.db, [entryId]);
    const same = servers.find(
      (s) =>
        s.host.toLowerCase() === job.host.toLowerCase() &&
        s.port === job.port &&
        s.username === job.view.username,
    );
    let vaultServerId = same?.id ?? null;
    if (!vaultServerId) {
      const taken = new Set(servers.map((s) => s.name.toLowerCase()));
      const base = serverName.slice(0, 36);
      let name = base;
      for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base}-${n}`;
      const added = await commit(addVaultSshServer, {
        entryId,
        name,
        host: job.host,
        port: job.port,
        username: job.view.username,
      });
      vaultServerId = added.serverId;
    }
    await commit(trustVaultSshHostKey, {
      entryId,
      serverId: vaultServerId,
      at: { host: job.host, port: job.port },
      hostKey,
    });
    return true;
  }

  /** `hosts.change` as the person (no address, password or token): “Added pve-03 with full control”. */
  async #sign(
    job: Job,
    serverId: string,
    already: boolean,
    enrollmentId: string | null,
    repoint: boolean,
  ): Promise<void> {
    const text =
      repoint && already
        ? repointChangeText(serverId)
        : installChangeText(serverId, job.view.control, already);
    await this.services.pipeline
      .commit(
        recordHostsChange,
        {
          text,
          op: repoint ? 'repoint' : 'install',
          serverId,
          ids: { installId: job.view.id, ...(enrollmentId ? { enrollmentId } : {}) },
          change: { title: text },
        },
        { burrowId: job.burrowId, actorId: job.personId },
      )
      .catch((err: unknown) =>
        this.services.log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'hosts: the install wasn’t signed',
        ),
      );
  }

  /**
   * Waits for the agent's first report since the installer started (the fleet's `last_seen`, read again on the
   * server's events and every `pollMs`); answers the server's name in Whombat, or null when it didn't come in time.
   */
  async #firstReport(serverId: string, since: number): Promise<string | null> {
    const hosts = this.#hosts;
    const until = Date.now() + this.timing.reportMs;
    let wake: () => void = () => {};
    const off = hosts.onChange((c) => {
      if ((c.kind === 'server' && c.serverId === serverId) || c.kind === 'resync') wake();
    });
    try {
      for (;;) {
        hosts.forget('fleet');
        const fleet = await hosts.fleetRaw().catch(() => null);
        const card = arr(fleet?.servers)
          .map(obj)
          .find((c) => c.id === serverId);
        const seen = card ? Date.parse(str(card.last_seen) ?? '') : Number.NaN;
        if (card && Number.isFinite(seen) && seen >= since - 2_000) {
          const hostname = str(card.hostname);
          return hostname && hostname.toLowerCase() === serverId.toLowerCase() ? hostname : serverId;
        }
        const left = until - Date.now();
        if (left <= 0) return null;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.min(this.timing.pollMs, left));
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
    } finally {
      off();
    }
  }

  #failureOf(job: Job, err: unknown, signedIn: boolean): { failure: InstallFailure; detail: string | null } {
    const plain = (failure: InstallFailure) => ({ failure, detail: null });
    if (err instanceof InstallStop) return { failure: err.failure, detail: err.detail };
    if (err instanceof SshFailure) {
      if (signedIn)
        return plain(
          err.reason === 'timeout'
            ? { code: 'timed_out' }
            : { code: 'failed', message: INSTALL_TEXT.connectionBroke(job.view.address) },
        );
      switch (err.reason) {
        case 'not_allowed':
          return plain({ code: 'not_allowed', message: err.message });
        case 'host_key_changed':
          return plain({ code: 'host_key_changed' });
        case 'rejected':
          return plain({ code: 'sign_in_failed' });
        case 'timeout':
          return plain({ code: 'timed_out' });
        default:
          return plain({ code: 'unreachable' });
      }
    }
    if (err instanceof HostsUnavailable) return plain({ code: 'failed', message: HOSTS_TEXT.down });
    if (err instanceof HostsError) return plain({ code: 'failed', message: hostsErrorText(err, {}) });
    this.services.log.warn({ err: err instanceof Error ? err.name : 'error' }, 'hosts: an install failed');
    return plain({ code: 'failed' });
  }
}

const instances = new WeakMap<object, HostInstalls>();

/** The process's install jobs (one set per `Services`). */
export function installsFor(services: Services): HostInstalls {
  let jobs = instances.get(services);
  if (!jobs) {
    jobs = new HostInstalls(services);
    instances.set(services, jobs);
  }
  return jobs;
}
