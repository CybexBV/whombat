// A malicious project tool (repository hook, npm postinstall, MCP server): tries everything a managed task
// must not reach and records what worked. Paths come from PROBE_* variables the test sets.
import { createSocket } from 'node:dgram';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';

const label = process.argv[2] ?? 'probe';
const env = process.env;
const targets = JSON.parse(env.PROBE_TARGETS ?? '{}');
// How long a network check waits for an answer (`timeoutMs` in PROBE_TARGETS, else 2 s). What gets through a hole in
// the wall answers within milliseconds, so a test may wait less; only the unanswered checks wait this long.
const timeoutMs = Number(targets.timeoutMs) > 0 ? Number(targets.timeoutMs) : 2000;

const tryRead = (path) => () => {
  readFileSync(path);
  return true;
};
const tryList = (path) => () => readdirSync(path).length >= 0;
const tryWrite = (path) => () => {
  writeFileSync(path, 'x');
  return true;
};
const tryUnix = (path) => () =>
  new Promise((resolve, reject) => {
    const s = connect(path);
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', reject);
  });
const tryTcp = (host, port) => () =>
  new Promise((resolve, reject) => {
    const s = connect({ host, port, timeout: timeoutMs });
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('timeout', () => {
      s.destroy();
      reject(new Error('timeout'));
    });
    s.once('error', reject);
  });
const tryDns = (server) => () =>
  new Promise((resolve, reject) => {
    const u = createSocket(server.includes(':') ? 'udp6' : 'udp4');
    // A query for example.com A.
    const q = Buffer.from('abcd01000001000000000000076578616d706c6503636f6d0000010001', 'hex');
    const timer = setTimeout(() => {
      u.close();
      reject(new Error('no answer'));
    }, timeoutMs);
    u.once('message', () => {
      clearTimeout(timer);
      u.close();
      resolve(true);
    });
    u.once('error', (e) => {
      clearTimeout(timer);
      u.close();
      reject(e);
    });
    u.send(q, 53, server);
  });

const checks = {
  ownCredential: tryRead(targets.ownCredential),
  otherIdentityCredential: tryRead(targets.otherCredential),
  masterKey: tryRead(targets.masterKey),
  whombatHome: tryRead(targets.whombatHomeFile),
  persistIdentity: tryRead(targets.identityKey),
  hostClaudeLogin: tryRead(`${targets.hostHome}/.claude/.credentials.json`),
  hostCodexLogin: tryRead(`${targets.hostHome}/.codex/auth.json`),
  hostSshDir: tryList(`${targets.hostHome}/.ssh`),
  hostGhConfig: tryList(`${targets.hostHome}/.config/gh`),
  otherUsersHome: tryList('/root'),
  fakeDockerSocket: tryUnix(targets.dockerSocket),
  hostDockerSocket: tryUnix('/var/run/docker.sock'),
  managerSocket: tryUnix(targets.managerSocket),
  helperSocket: tryUnix(targets.helperSocket),
  postgresSocket: tryUnix(targets.postgresSocket),
  hostPostgresSocket: tryUnix('/run/postgresql/.s.PGSQL.5432'),
  sshAgentSocket: tryUnix(targets.sshAgent),
  sshAuthSockSet: () => {
    if (!env.SSH_AUTH_SOCK) throw new Error('unset');
    return true;
  },
  // A runner-level credential (every one the test planted is `LEAK-<name>`) in this tool's environment.
  secretInEnvironment: () => {
    const leaked = Object.entries(env)
      .filter(([, v]) => String(v).includes('LEAK-'))
      .map(([k]) => k);
    if (!leaked.length) throw new Error('none');
    throw Object.assign(new Error(leaked.join(',')), { reached: true });
  },
  runnerProcEnviron: tryRead(`/proc/${targets.runnerPid}/environ`),
  runnerVisibleInProc: () => {
    const pids = readdirSync('/proc').filter((p) => /^\d+$/.test(p));
    const seen = pids.some((p) => {
      try {
        return readFileSync(`/proc/${p}/cmdline`, 'utf8').includes(targets.runnerMarker);
      } catch {
        return false;
      }
    });
    if (!seen) throw new Error('not visible');
    return true;
  },
  writeSystem: tryWrite('/usr/whombat-probe'),
  writeHostTmp: tryWrite(`${targets.hostTmp}/whombat-probe-${label}`),
  tcpHostLoopback: tryTcp('127.0.0.1', targets.hostPort),
  tcpPrivate10: tryTcp('10.0.0.1', 80),
  tcpPrivate192: tryTcp('192.168.1.1', 80),
  tcpMetadata: tryTcp('169.254.169.254', 80),
  tcpIpv6Loopback: tryTcp('::1', targets.hostPort),
  tcpIpv6Ula: tryTcp('fd00::1', 80),
  tcpPublicDirect: tryTcp('1.1.1.1', 443),
  dnsOtherServer: tryDns('8.8.8.8'),
  dnsOtherServerV6: tryDns('2001:4860:4860::8888'),
};

const results = {};
// All at once: the network checks that get no answer wait out their timeout together, not one after another.
await Promise.all(
  Object.entries(checks).map(async ([name, check]) => {
    try {
      results[name] = { reached: (await check()) === true };
    } catch (err) {
      results[name] = { reached: err.reached === true, error: String(err.code ?? err.message ?? err) };
    }
  }),
);
writeFileSync(`${env.PROBE_OUT}/${label}.json`, JSON.stringify(results, null, 1));
