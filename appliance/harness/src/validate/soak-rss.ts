/** RSS sampling and the soak verdict (IN-23); no client imports, so unit tests and validate can use it. */
import { readdirSync, readFileSync } from 'node:fs';
import { loadEnv, type ServiceName } from '../dev/env.ts';

export const SOAK_SERVICES: ServiceName[] = [
  'runtime',
  'runner',
  'control',
  'relay',
  'manager',
  'helper',
  'backup',
];

export interface SoakSample {
  t: number;
  rss: Record<string, number | null>;
  pids: Record<string, number[]>;
}

export interface SoakResultBase {
  durationS: number;
  intervalS: number;
  samples: number;
  services: Record<
    string,
    {
      firstMiB: number | null;
      lastMiB: number | null;
      maxMiB: number | null;
      growthMiB: number | null;
      restarts: number;
      verdict: 'ok' | 'growth' | 'restarted' | 'missing';
    }
  >;
  /** The first failed requests, with their errors. */
  errorLog?: { at: string; error: string }[];
  traffic: {
    requests: number;
    errors: number;
    tasks: number;
    replies: number;
    uploads: number;
    uploadErrors: number;
    reconnects: number;
  };
  ok: boolean;
  reasons: string[];
  seriesFile: string;
}

/** pid → pgid for all processes. */
function processGroups(): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const d of readdirSync('/proc')) {
    const pid = Number(d);
    if (!Number.isInteger(pid)) continue;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const pgid = Number(fields[2]);
      const list = out.get(pgid) ?? [];
      list.push(pid);
      out.set(pgid, list);
    } catch {
      // gone
    }
  }
  return out;
}

function rssKiB(pid: number): number {
  try {
    const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

export function sample(): SoakSample {
  const env = loadEnv();
  const groups = processGroups();
  const s: SoakSample = { t: Date.now(), rss: {}, pids: {} };
  for (const name of SOAK_SERVICES) {
    const leader = env?.services[name]?.pid ?? null;
    const pids = leader ? (groups.get(leader) ?? []) : [];
    s.pids[name] = pids.sort((a, b) => a - b);
    s.rss[name] = pids.length ? Math.round(pids.reduce((n, p) => n + rssKiB(p), 0) / 1024) : null;
  }
  return s;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function judge(
  samples: SoakSample[],
  warmupMs: number,
): Pick<SoakResultBase, 'services' | 'ok' | 'reasons'> {
  const services: SoakResultBase['services'] = {};
  const reasons: string[] = [];
  const t0 = samples[0]?.t ?? 0;
  for (const name of SOAK_SERVICES) {
    const series = samples.map((x) => x.rss[name]);
    if (series.every((v) => v === null)) {
      services[name] = {
        firstMiB: null,
        lastMiB: null,
        maxMiB: null,
        growthMiB: null,
        restarts: 0,
        verdict: 'missing',
      };
      continue;
    }
    let restarts = 0;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1]?.pids[name] ?? [];
      const b = samples[i]?.pids[name] ?? [];
      // A restart: pids that were there are gone and new ones appeared, or the group vanished.
      if (a.length && (!b.length || (a.some((p) => !b.includes(p)) && b.some((p) => !a.includes(p)))))
        restarts++;
    }
    const warm = samples
      .filter((x) => x.t - t0 >= warmupMs && x.rss[name] !== null)
      .map((x) => x.rss[name] as number);
    const fifth = Math.max(1, Math.floor(warm.length / 5));
    const first = warm.length ? mean(warm.slice(0, fifth)) : null;
    const last = warm.length ? mean(warm.slice(-fifth)) : null;
    const growth = first !== null && last !== null ? last - first : null;
    const max = Math.max(...(series.filter((v) => v !== null) as number[]));
    let verdict: SoakResultBase['services'][string]['verdict'] = 'ok';
    if (restarts > 0) verdict = 'restarted';
    else if (first !== null && growth !== null && growth > Math.max(64, first * 0.25)) verdict = 'growth';
    if (verdict !== 'ok')
      reasons.push(
        `${name}: ${verdict}${verdict === 'growth' ? ` (+${Math.round(growth ?? 0)} MiB from ${Math.round(first ?? 0)} MiB)` : ` (${restarts}×)`}`,
      );
    services[name] = {
      firstMiB: first === null ? null : Math.round(first),
      lastMiB: last === null ? null : Math.round(last),
      maxMiB: max,
      growthMiB: growth === null ? null : Math.round(growth),
      restarts,
      verdict,
    };
  }
  return { services, ok: reasons.length === 0, reasons };
}
