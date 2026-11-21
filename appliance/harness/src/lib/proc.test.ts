import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TMP_DIR } from './paths.ts';
import { alive, callerUnit, RECLAIM_SH, run, scopeCommand, scopes } from './proc.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(TMP_DIR, 'proc-test-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it('flushes the entire log before returning even when capture is truncated', async () => {
  const logFile = join(dir, 'run.log');
  const r = await run(
    process.execPath,
    ['-e', "process.stdout.write('x'.repeat(100000)); process.stderr.write('last-byte')"],
    { cwd: dir, logFile, maxCapture: 20 },
  );
  expect(r.code).toBe(0);
  const log = readFileSync(logFile, 'utf8');
  expect(log).toContain('x'.repeat(100000));
  expect(log).toContain('last-byte');
  expect(log).toMatch(/\[exit 0 after \d+ ms\]\n$/);
  expect(r.stdout).toHaveLength(20);
});

it('records a spawn failure exactly once', async () => {
  const logFile = join(dir, 'missing.log');
  expect((await run(join(dir, 'missing'), [], { cwd: dir, logFile })).code).toBe(127);
  expect(readFileSync(logFile, 'utf8').match(/\[exit /g)).toHaveLength(1);
});

describe('a command in a scope of its own (memoryHigh)', () => {
  const T3 =
    '0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-t3code.slice/app-t3code-agents.slice/app-t3code-agents-3b09d19b1f5d.slice/t3code-claude-70a4db4f.scope\n';

  it('is stopped with the user unit it was started from, in its slice', () => {
    expect(callerUnit(T3)).toEqual({
      unit: 't3code-claude-70a4db4f.scope',
      slice: 'app-t3code-agents-3b09d19b1f5d.slice',
    });
    expect(callerUnit('0::/user.slice/user-1000.slice/user@1000.service/app.slice/t3code.service')).toEqual({
      unit: 't3code.service',
      slice: 'app.slice',
    });
    expect(callerUnit('0::/user.slice/user-1000.slice/session-431.scope\n')).toBeNull();
    expect(callerUnit('0::/user.slice/user-1000.slice/user@1000.service/init.scope')).toBeNull();
    expect(callerUnit('0::/system.slice/ssh.service')).toBeNull();
    expect(callerUnit('')).toBeNull();
  });

  it('runs under systemd-run, which execs the command itself', () => {
    const caller = { unit: 't3code-claude-70a4db4f.scope', slice: 'app-t3code-agents-3b09d19b1f5d.slice' };
    expect(
      scopeCommand('tar', ['czf', 'a b.tgz'], {
        memoryHigh: '1G',
        unit: 'wb-run-1-1.scope',
        caller,
        reclaim: true,
      }),
    ).toEqual({
      cmd: 'systemd-run',
      args: [
        '--user',
        '--scope',
        '--quiet',
        '--collect',
        '--expand-environment=no',
        '--unit=wb-run-1-1.scope',
        '--slice=app-t3code-agents-3b09d19b1f5d.slice',
        '-p',
        'BindsTo=t3code-claude-70a4db4f.scope',
        '-p',
        'MemoryHigh=1G',
        '--',
        '/bin/sh',
        '-c',
        RECLAIM_SH,
        'sh',
        'tar',
        'czf',
        'a b.tgz',
      ],
    });
    expect(
      scopeCommand('git', [], { memoryHigh: '512M', unit: 'u.scope', caller: null, reclaim: false }).args,
    ).toEqual([
      '--user',
      '--scope',
      '--quiet',
      '--collect',
      '--expand-environment=no',
      '--unit=u.scope',
      '-p',
      'MemoryHigh=512M',
      '--',
      'git',
    ]);
    expect(() =>
      scopeCommand('git', [], { memoryHigh: '1 GB', unit: 'u.scope', caller: null, reclaim: true }),
    ).toThrow(/not a size/);
  });

  it('is never asked for with WB_MEMORY_SCOPE=0, in a nix build or a container', () => {
    expect(scopes({ WB_MEMORY_SCOPE: '0' })).toBe(false);
    expect(scopes({ NIX_BUILD_TOP: '/build' })).toBe(false);
    expect(scopes({ container: 'podman' })).toBe(false);
  });

  // Where the user manager makes scopes (the build machine); elsewhere the command runs as it is, as the next test checks.
  it.skipIf(!scopes())(
    'runs there with the same output and exit code, and a timeout kills all of it',
    async () => {
      const logFile = join(dir, 'scoped.log');
      const r = await run(
        'sh',
        [
          '-c',
          'cat /proc/self/cgroup; cat "/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)/memory.high"; exit 3',
        ],
        { cwd: dir, logFile, memoryHigh: '256M' },
      );
      expect(r.code).toBe(3);
      expect(r.stdout).toMatch(new RegExp(`/wb-run-${process.pid}-\\d+\\.scope\n${256 * 1024 * 1024}\n$`));
      expect(r.command).toBe(
        `sh -c 'cat /proc/self/cgroup; cat "/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)/memory.high"; exit 3'`,
      );
      expect(readFileSync(logFile, 'utf8')).toMatch(/^\n\$ \(cd \S+ && sh -c /);
      // The arguments reach the command as they are: systemd-run would otherwise expand `${HOME}` and turn `$$` into `$`.
      // biome-ignore lint/suspicious/noTemplateCurlyInString: these words, as they are, are what is checked
      const words = '${HOME} $$ $HOME';
      const literal = await run('printf', ['%s\\n', words], { cwd: dir, memoryHigh: '256M' });
      expect([literal.code, literal.stdout]).toEqual([0, `${words}\n`]);
      const signalled = await run('sh', ['-c', 'kill -TERM $$'], { cwd: dir, memoryHigh: '256M' });
      expect([signalled.code, signalled.signal]).toEqual([null, 'SIGTERM']);
      const piped = await run('sh', ['-c', 'cat; exit 200'], { cwd: dir, memoryHigh: '256M', input: 'in\n' });
      expect([piped.code, piped.stdout, piped.stderr]).toEqual([200, 'in\n', '']);

      // A child that left the process group (setsid) holds stdout open: only the scope's kill ends it.
      const started = Date.now();
      const t = await run('sh', ['-c', 'setsid sleep 60 & echo $!; wait'], {
        cwd: dir,
        memoryHigh: '256M',
        timeoutMs: 500,
      });
      expect(t.timedOut).toBe(true);
      expect(Date.now() - started).toBeLessThan(15_000);
      const pid = Number(t.stdout.trim());
      expect(pid).toBeGreaterThan(0);
      // systemd kills the scope asynchronously: on a busy host the process may outlive the run by a moment.
      await expect.poll(() => alive(pid), { timeout: 5_000, interval: 50 }).toBe(false);
    },
  );

  it('runs as it is without a scope, and a missing command is still 127', async () => {
    const prev = process.env.WB_MEMORY_SCOPE;
    process.env.WB_MEMORY_SCOPE = '0';
    try {
      const r = await run('sh', ['-c', 'cat /proc/self/cgroup'], { cwd: dir, memoryHigh: '256M' });
      expect(r.code).toBe(0);
      expect(r.stdout).not.toContain('/wb-run-');
    } finally {
      if (prev === undefined) delete process.env.WB_MEMORY_SCOPE;
      else process.env.WB_MEMORY_SCOPE = prev;
    }
    expect((await run(join(dir, 'missing'), [], { cwd: dir, memoryHigh: '256M' })).code).toBe(127);
    expect((await run('wb-no-such-command', [], { cwd: dir, memoryHigh: '256M' })).code).toBe(127);
  });
});
