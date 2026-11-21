/**
 * A person's pod's payload on the host (hermes-native.md HN-W01, HN-W02, HN-W11; the walls are `sandbox.test.ts`'s): it
 * keeps a gateway and a spare `hermes acp` up, hands the spare to a turn as a process the runner drives, refuses a turn
 * whose folder isn't there, starts a crashed gateway again and ends everything on stop.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { podAcpProcess, podRequest } from './pod';
import { POD_INIT_PATH } from './sandbox';

const FAKE = fileURLToPath(new URL('./testing/fake-pod-hermes.mjs', import.meta.url));

interface Started {
  child: ChildProcess;
  dir: string;
  socket: string;
  roots: string;
  log: () => string;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** One line from a stream, as soon as it comes. */
function nextLine(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (d: Buffer | string) => {
      buf += d.toString();
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      stream.off('data', onData);
      resolve(buf.slice(0, nl));
    };
    stream.on('data', onData);
    stream.once('end', () => reject(new Error(`ended: ${buf}`)));
  });
}

describe('pod-init', () => {
  const started: Started[] = [];
  afterEach(async () => {
    for (const s of started.splice(0)) {
      // Gracefully, so its children (each in a group of its own) go with it; killed when it doesn't answer.
      if (s.child.exitCode === null) {
        const exited = new Promise((r) => s.child.once('exit', r));
        await podRequest(s.socket, 'stop', 2000).catch(() => s.child.kill('SIGKILL'));
        await exited;
      }
      rmSync(s.dir, { recursive: true, force: true });
    }
  });

  async function startPod(over: Record<string, unknown> = {}): Promise<Started> {
    const dir = mkdtempSync(join(tmpdir(), 'wb-pod-'));
    const roots = join(dir, 'workspaces');
    mkdirSync(roots);
    const socket = join(dir, 'pod.sock');
    const config = {
      socket,
      hermes: FAKE,
      gateway: ['gateway', 'run', '--quiet'],
      acp: ['acp'],
      spares: 1,
      cwd: dir,
      backoffMs: [10],
      killGraceMs: 500,
      ...over,
    };
    const child = spawn(process.execPath, [POD_INIT_PATH, JSON.stringify(config)], {
      env: { PATH: process.env.PATH ?? '', FAKE_POD_DIR: dir, FAKE_POD_MARK: 'pod-env' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stderr?.on('data', (d: Buffer) => {
      log += d.toString();
    });
    const s: Started = { child, dir, socket, roots, log: () => log };
    started.push(s);
    expect(JSON.parse(await nextLine(child.stdout as NodeJS.ReadableStream))).toEqual({ ready: true });
    return s;
  }

  const gatewayPids = (dir: string) =>
    existsSync(join(dir, 'gateway.pids'))
      ? readFileSync(join(dir, 'gateway.pids'), 'utf8').trim().split('\n').filter(Boolean).map(Number)
      : [];

  it('hands its spare hermes acp to a turn, with the pod’s environment, and starts the next spare', async () => {
    const pod = await startPod();
    await vi.waitFor(async () =>
      expect(await podRequest(pod.socket, 'status')).toMatchObject({ gateway: { up: true }, spares: 1 }),
    );
    const cwd = join(pod.roots, 'repo-1', 'work');
    mkdirSync(cwd, { recursive: true });
    const viewer = podAcpProcess(pod.socket, cwd);
    viewer.stdin.write('{"hello":1}\n');
    const answer = JSON.parse(await nextLine(viewer.stdout));
    expect(answer).toMatchObject({ echo: '{"hello":1}', pod: 'pod-env', token: null });
    await vi.waitFor(async () =>
      expect(await podRequest(pod.socket, 'status')).toMatchObject({ spares: 1, viewers: 1 }),
    );
    // The turn lets go: its hermes acp ends in the pod, and the process says so.
    const exited = new Promise((r) => viewer.once('exit', r));
    viewer.stdin.destroy();
    await exited;
    await vi.waitFor(() => expect(alive(answer.pid)).toBe(false));
    await vi.waitFor(async () =>
      expect(await podRequest(pod.socket, 'status')).toMatchObject({ viewers: 0 }),
    );
  });

  it('refuses a turn whose folder isn’t there', async () => {
    const pod = await startPod();
    const outside = join(pod.dir, 'elsewhere', 'x');
    const viewer = podAcpProcess(pod.socket, outside);
    const exit = new Promise<number | null>((r) => viewer.once('exit', (code) => r(code)));
    const said = nextLine(viewer.stderr);
    expect(await exit).toBe(1);
    expect(await said).toMatch(/folder/);
    expect(existsSync(outside)).toBe(false);
    const relative = podAcpProcess(pod.socket, 'workspaces/../../etc');
    expect(await new Promise((r) => relative.once('exit', (code) => r(code)))).toBe(1);
  });

  it('starts a crashed gateway again, and gives up after three quick exits', async () => {
    const pod = await startPod();
    await vi.waitFor(() => expect(gatewayPids(pod.dir)).toHaveLength(1));
    process.kill(gatewayPids(pod.dir)[0] as number, 'SIGKILL');
    await vi.waitFor(() => expect(gatewayPids(pod.dir)).toHaveLength(2));
    await vi.waitFor(async () =>
      expect(await podRequest(pod.socket, 'status')).toMatchObject({ gateway: { up: true, starts: 2 } }),
    );
    for (const n of [2, 3]) {
      await vi.waitFor(() => expect(gatewayPids(pod.dir)).toHaveLength(n));
      process.kill(gatewayPids(pod.dir)[n - 1] as number, 'SIGKILL');
    }
    await vi.waitFor(async () =>
      expect(await podRequest(pod.socket, 'status')).toMatchObject({ gateway: { up: false, gaveUp: true } }),
    );
    expect(pod.log()).toMatch(/gateway exited/);
  });

  it('runs without a gateway (the scripted Hermes), and ends every process on stop', async () => {
    const pod = await startPod({ gateway: null });
    const viewer = podAcpProcess(pod.socket, pod.dir);
    viewer.stdin.write('x\n');
    const { pid } = JSON.parse(await nextLine(viewer.stdout));
    expect(await podRequest(pod.socket, 'status')).toMatchObject({ gateway: null, viewers: 1 });
    const exited = new Promise((r) => pod.child.once('exit', (code) => r(code)));
    expect(await podRequest(pod.socket, 'stop')).toMatchObject({ ok: true });
    expect(await exited).toBe(0);
    expect(alive(pid)).toBe(false);
    expect(existsSync(pod.socket)).toBe(false);
  });
});
