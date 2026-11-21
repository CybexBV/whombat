/**
 * Tests only: a TrueNAS's apps, datasets, jobs, files and NFS shares as the fake socket answers them
 * (`connections/socket/testing.ts` `fakeTrueNas`'s `methods`), after TrueNAS's documented answers for 24.10…25.10.
 */
import { parse } from 'yaml';

export interface FakeState {
  version: string;
  pool: string | null;
  docker: string;
  datasets: Map<string, { used: number; available: number }>;
  apps: Map<string, { state: string; yaml: string }>;
  jobs: Map<number, { polls: number; fail: boolean; done: () => void }>;
  files: Map<string, number>;
  nfs: { id: number; path: string; hosts: string[]; maproot_user: string; enabled: boolean }[];
  nfsService: { enable: boolean; state: string };
  failNextJob: boolean;
  usedPorts: number[];
  /** Polls a job answers RUNNING before it is done (1: done at the first). */
  jobPolls: number;
  /** The pools `pool.query` lists (default: only the apps pool). */
  pools: { name: string; status: string; free: number }[] | null;
}

export function fakeTrueNasState(over: Partial<FakeState> = {}): FakeState {
  return {
    version: '25.10.1',
    pool: 'tank',
    docker: 'RUNNING',
    datasets: new Map(),
    apps: new Map(),
    jobs: new Map(),
    files: new Map(),
    nfs: [],
    nfsService: { enable: false, state: 'STOPPED' },
    failNextJob: false,
    usedPorts: [8747],
    jobPolls: 2,
    pools: null,
    ...over,
  };
}

const idFilter = (params: unknown, field = 'id'): string | null => {
  const filters = (params as unknown[][][])?.[0];
  const f = filters?.find((x) => x[0] === field);
  return f ? String(f[2]) : null;
};

export function fakeTrueNasMethods(s: FakeState): Record<string, (params: unknown) => unknown> {
  let nextJob = 1;
  const job = (done: () => void) => {
    const id = nextJob++;
    s.jobs.set(id, { polls: 0, fail: s.failNextJob, done });
    s.failNextJob = false;
    return id;
  };
  const p = (params: unknown) => params as unknown[];
  return {
    'system.info': () => ({ version: s.version }),
    'docker.config': () => ({ pool: s.pool, dataset: s.pool ? `${s.pool}/ix-apps` : null }),
    'docker.status': () => ({ status: s.docker, description: '' }),
    'pool.query': () =>
      (s.pools ?? (s.pool ? [{ name: s.pool, status: 'ONLINE', free: 1_000_000 }] : [])).map((pool, i) => ({
        id: i + 1,
        ...pool,
      })),
    'pool.dataset.query': (params) => {
      const id = idFilter(params);
      const ds = id ? s.datasets.get(id) : undefined;
      return ds && id
        ? [
            {
              id,
              name: id,
              mountpoint: `/mnt/${id}`,
              used: { parsed: ds.used },
              available: { parsed: ds.available },
            },
          ]
        : [];
    },
    'pool.dataset.create': (params) => {
      const name = String((p(params)[0] as Record<string, unknown>).name);
      if (s.datasets.has(name))
        return { error: { code: -32001, message: 'exists', data: { errname: 'EEXIST' } } };
      s.datasets.set(name, { used: 0, available: 1_000_000 });
      return { id: name, name, mountpoint: `/mnt/${name}` };
    },
    'pool.dataset.delete': (params) => {
      s.datasets.delete(String(p(params)[0]));
      return true;
    },
    'app.query': (params) => {
      const id = idFilter(params);
      const app = id ? s.apps.get(id) : undefined;
      return app && id ? [{ id, name: id, state: app.state }] : [];
    },
    'app.config': (params) => {
      const app = s.apps.get(String(p(params)[0]));
      return app ? parse(app.yaml) : { error: { code: -32001, message: 'no app' } };
    },
    'app.used_ports': () => s.usedPorts,
    'app.create': (params) => {
      const a = p(params)[0] as Record<string, unknown>;
      const name = String(a.app_name);
      s.apps.set(name, { state: 'DEPLOYING', yaml: String(a.custom_compose_config_string) });
      return job(() => {
        const app = s.apps.get(name);
        if (app) app.state = 'RUNNING';
      });
    },
    'app.update': (params) => {
      const [name, a] = p(params) as [string, Record<string, unknown>];
      const app = s.apps.get(name);
      if (!app) return { error: { code: -32001, message: 'no app' } };
      app.yaml = String(a.custom_compose_config_string);
      // A stopped app only saves its new compose.
      return job(() => {});
    },
    'app.start': (params) =>
      job(() => {
        const app = s.apps.get(String(p(params)[0]));
        if (app) app.state = 'RUNNING';
      }),
    'app.delete': (params) => job(() => s.apps.delete(String(p(params)[0]))),
    'core.get_jobs': (params) => {
      const id = Number(idFilter(params));
      const j = s.jobs.get(id);
      if (!j) return [];
      j.polls++;
      if (j.polls < s.jobPolls) return [{ id, state: 'RUNNING', progress: { percent: 50 } }];
      if (j.fail) return [{ id, state: 'FAILED', error: 'compose failed' }];
      j.done();
      return [{ id, state: 'SUCCESS', result: null }];
    },
    'filesystem.stat': (params) => {
      const mtime = s.files.get(String(p(params)[0]));
      return mtime === undefined
        ? { error: { code: -32001, message: 'not found', data: { errname: 'ENOENT' } } }
        : { mtime, size: 10 };
    },
    'sharing.nfs.query': (params) => {
      const path = idFilter(params, 'path');
      return s.nfs.filter((n) => n.path === path);
    },
    'sharing.nfs.create': (params) => {
      const a = p(params)[0] as Record<string, unknown>;
      const share = {
        id: s.nfs.length + 1,
        path: String(a.path),
        hosts: a.hosts as string[],
        maproot_user: String(a.maproot_user),
        enabled: true,
      };
      s.nfs.push(share);
      return share;
    },
    'sharing.nfs.update': (params) => {
      const [id, a] = p(params) as [number, Record<string, unknown>];
      const share = s.nfs.find((n) => n.id === id);
      if (share) share.hosts = a.hosts as string[];
      return share;
    },
    'service.query': () => [{ service: 'nfs', ...s.nfsService }],
    'service.update': () => {
      s.nfsService.enable = true;
      return 1;
    },
    'service.start': () => {
      s.nfsService.state = 'RUNNING';
      return true;
    },
  };
}
