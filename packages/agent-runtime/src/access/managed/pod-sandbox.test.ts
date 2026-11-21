/**
 * A person's pod in the real managed sandbox (hermes-native.md HN-W01…HN-W03; bubblewrap and a systemd --user scope on
 * this host, as `sandbox.test.ts`): `pod-init` hands the runner a `hermes acp` started inside the pod's namespaces; the
 * pod sees the turns' folders at their own paths (one-person.md OP-S109), not its own control directory, not another
 * pod's socket or profile. Skipped — with the reason — where the host can't build the sandbox.
 */
import { type ChildProcessWithoutNullStreams, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SystemdUserCgroups } from './cgroup';
import { podAcpProcess, podRequest } from './pod';
import { ManagedSandbox, POD_INIT_PATH, type SandboxSession } from './sandbox';

const testing = fileURLToPath(new URL('./testing/', import.meta.url));
const FAKE = join(testing, 'fake-pod-hermes.mjs');
const slice = `wbpodtest${process.pid}.slice`;
const bwrap = ['/usr/bin/bwrap', '/run/current-system/sw/bin/bwrap'].find((p) => {
  try {
    return spawnSync(p, ['--version']).status === 0;
  } catch {
    return false;
  }
});

const probeDir = mkdtempSync(join(tmpdir(), 'wb-podprobe-'));
const probe = bwrap
  ? new ManagedSandbox({
      bwrap,
      cgroups: new SystemdUserCgroups({ slice, generation: 'gpodprobe' }),
      stateDir: probeDir,
      prefix: 'gpodprobe',
    })
  : null;
const availability = probe ? await probe.probe() : { ok: false, detail: 'no bubblewrap' };
if (!availability.ok) console.warn(`pod sandbox tests skipped: ${availability.detail}`);

// After the describe, or without it: the probe's scope and the slice, so no unit of this run outlives it.
afterAll(async () => {
  await probe?.shutdown();
  spawnSync('systemctl', ['--user', 'stop', slice]);
  rmSync(probeDir, { recursive: true, force: true });
});

function nextLine(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (d: Buffer | string) => {
      buf += d.toString();
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      stream.off('data', onData);
      stream.off('end', onEnd);
      resolve(buf.slice(0, nl));
    };
    const onEnd = () => reject(new Error(`ended: ${buf}`));
    stream.on('data', onData);
    stream.once('end', onEnd);
  });
}

describe.runIf(availability.ok)('a pod in the managed sandbox', () => {
  let root: string;
  let sandbox: ManagedSandbox;
  const opened: SandboxSession[] = [];

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'wb-podsb-'));
    sandbox = new ManagedSandbox({
      bwrap: bwrap as string,
      cgroups: new SystemdUserCgroups({ slice, generation: 'gpod' }),
      stateDir: join(root, 'state'),
      prefix: 'gpod',
      deniedPaths: [join(root, 'persist')],
    });
    // A turn's folder on the host, with something in it the pod must not see.
    mkdirSync(join(root, 'workspaces', 'repo'), { recursive: true });
    writeFileSync(join(root, 'workspaces', 'repo', 'AGENTS.md'), 'host file\n');
    for (const who of ['alice', 'bob']) {
      mkdirSync(join(root, 'persist', 'hermes', 'profiles', who), { recursive: true });
      writeFileSync(join(root, 'persist', 'hermes', 'profiles', who, 'memory.md'), `${who}\n`);
      mkdirSync(join(root, 'pods', who, 'run'), { recursive: true });
    }
  });

  afterAll(async () => {
    for (const s of opened) await s.close().catch(() => {});
    await sandbox?.shutdown();
    rmSync(root, { recursive: true, force: true });
  });

  /** Opens a person's pod and starts its `pod-init`; resolves once it serves. */
  async function openPod(
    who: string,
  ): Promise<{ session: SandboxSession; socket: string; init: ChildProcessWithoutNullStreams }> {
    const run = join(root, 'pods', who, 'run');
    const profile = join(root, 'persist', 'hermes', 'profiles', who);
    const session = await sandbox.open({
      id: `pod_${who}`,
      cwd: run,
      writeCwd: true,
      stateDirs: [profile],
      installs: [testing, dirname(POD_INIT_PATH)],
      denied: [join(root, 'persist')],
      egress: { allow: [] },
      env: { HERMES_HOME: profile },
      readable: [join(root, 'workspaces')],
      pod: true,
    });
    opened.push(session);
    const socket = join(run, 'pod.sock');
    const init = session.spawn(
      process.execPath,
      [
        POD_INIT_PATH,
        JSON.stringify({
          socket,
          hermes: FAKE,
          gateway: ['gateway', 'run'],
          acp: ['acp'],
          spares: 1,
          cwd: run,
        }),
      ],
      { cwd: run, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', WHOMBAT_MCP_TOKEN: '' } },
    );
    init.stdin.end();
    expect(JSON.parse(await nextLine(init.stdout))).toEqual({ ready: true });
    return { session, socket, init };
  }

  it('starts hermes acp inside the pod, sees the turns’ folders at their own paths and its own profile only', async () => {
    const alice = await openPod('alice');
    const bob = await openPod('bob');
    const cwd = join(root, 'workspaces', 'repo');
    const viewer = podAcpProcess(alice.socket, cwd);
    viewer.stdin.write('hello\n');
    const said = JSON.parse(await nextLine(viewer.stdout));
    // Inside the pod's pid namespace (a small pid), started before the turn: the turn's folder is the session's, not the
    // process's.
    expect(said.pid).toBeLessThan(100);
    expect(said.cwd).toBe(join(root, 'pods', 'alice', 'run'));
    const control = join(root, 'state');
    viewer.stdin.write(
      `${JSON.stringify({
        probe: [
          cwd,
          join(root, 'persist', 'hermes', 'profiles', 'alice'),
          join(root, 'persist', 'hermes', 'profiles', 'bob'),
          join(root, 'pods', 'bob', 'run'),
          control,
        ],
      })}\n`,
    );
    const seen = JSON.parse(await nextLine(viewer.stdout)).probe;
    // The turns' folders at their own paths (one-person.md OP-S109): what a command binds is there.
    expect(seen[cwd]).toEqual({ exists: true, entries: ['AGENTS.md'] });
    expect(seen[join(root, 'persist', 'hermes', 'profiles', 'alice')].entries).toContain('memory.md');
    expect(seen[join(root, 'persist', 'hermes', 'profiles', 'bob')].exists).toBe(false);
    expect(seen[join(root, 'pods', 'bob', 'run')].exists).toBe(false);
    expect(seen[control].exists).toBe(false);
    expect(await podRequest(bob.socket, 'status')).toMatchObject({ ok: true, viewers: 0 });
    viewer.stdin.destroy();
    for (const pod of [alice, bob]) {
      const exited = new Promise((r) => pod.init.once('exit', (code) => r(code)));
      await podRequest(pod.socket, 'stop');
      expect(await exited).toBe(0);
    }
  }, 60_000);
});
