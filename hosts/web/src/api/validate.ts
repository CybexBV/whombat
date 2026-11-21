// Small runtime shape checks for API responses. The client runs them in dev
// builds (console warnings, never throws) so a hub response that drifts from
// the TypeScript types in types.ts is visible immediately; the unit tests run
// them against the hand-off fixtures (contract tests, ACCEPTANCE.md 0.2).

type Check = (v: unknown, path: string, errs: string[]) => void;

const typeOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

const prim =
  (t: 'string' | 'number' | 'boolean'): Check =>
  (v, p, e) => {
    if (typeof v !== t || (t === 'number' && !Number.isFinite(v as number))) e.push(`${p}: expected ${t}, got ${typeOf(v)}`);
  };

export const str = prim('string');
export const num = prim('number');
export const bool = prim('boolean');

export const nullable =
  (c: Check): Check =>
  (v, p, e) => {
    if (v !== null) c(v, p, e);
  };

/** Optional key (CONTRACT additions): may be absent; null allowed too. */
export const opt =
  (c: Check): Check =>
  (v, p, e) => {
    if (v !== undefined && v !== null) c(v, p, e);
  };

export const oneOf =
  (...vals: string[]): Check =>
  (v, p, e) => {
    if (typeof v !== 'string' || !vals.includes(v)) e.push(`${p}: expected one of ${vals.join('|')}, got ${JSON.stringify(v)}`);
  };

export const arr =
  (c: Check): Check =>
  (v, p, e) => {
    if (!Array.isArray(v)) {
      e.push(`${p}: expected array, got ${typeOf(v)}`);
      return;
    }
    v.forEach((x, i) => c(x, `${p}[${i}]`, e));
  };

export const record =
  (c: Check): Check =>
  (v, p, e) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      e.push(`${p}: expected object, got ${typeOf(v)}`);
      return;
    }
    for (const [k, x] of Object.entries(v)) c(x, `${p}.${k}`, e);
  };

export const obj =
  (shape: Record<string, Check>): Check =>
  (v, p, e) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      e.push(`${p}: expected object, got ${typeOf(v)}`);
      return;
    }
    const o = v as Record<string, unknown>;
    for (const [k, c] of Object.entries(shape)) c(o[k], `${p}.${k}`, e);
  };

const numOrNull = nullable(num);
const series = arr(numOrNull);
const status = oneOf('online', 'warning', 'offline');
const severity = oneOf('critical', 'warning');
const cpu = obj({ model: str, cores: num, threads: num });

export const alertSchema = obj({
  id: str,
  server: str,
  severity,
  title: str,
  detail: str,
  opened_at: str,
  rule: str,
  resolved_at: opt(str),
  state: opt(oneOf('open', 'resolved')),
});

export const hintSchema = obj({
  server: str,
  kind: str,
  severity: oneOf('warning', 'info'),
  entity: str,
  title: str,
  detail: str,
  link: str,
});

const current = obj({
  cpu_pct: numOrNull,
  mem_pct: numOrNull,
  temp_max_c: numOrNull,
  temp_limit_c: opt(num),
  disk_used_pct: numOrNull,
  disk_wear_max_pct: numOrNull,
});

export const fleetSchema = obj({
  as_of: str,
  groups: arr(obj({ name: str, count: num })),
  kpis: obj({
    servers_online: num,
    servers_total: num,
    cpu_avg_pct: numOrNull,
    memory_pct: numOrNull,
    memory_used_gb: num,
    memory_total_gb: num,
    storage_used_tb: num,
    storage_total_tb: num,
    storage_pct: numOrNull,
    disks_over_75_wear: num,
    open_alerts: num,
    open_alerts_critical: num,
    open_alerts_warning: num,
  }),
  servers: arr(
    obj({
      id: str,
      group: str,
      status,
      status_note: nullable(str),
      os: nullable(str),
      cpu: nullable(cpu),
      memory_total_gb: numOrNull,
      storage_capacity_tb: numOrNull,
      last_seen: nullable(str),
      current: nullable(current),
      last_known: nullable(record(numOrNull)),
      workloads: obj({
        docker: obj({ running: num, stopped: num, unhealthy: num }),
        incus: obj({ containers_running: num, vms_running: num, stopped: num }),
        qemu: obj({ running: num, stopped: num }),
      }),
      hypervisor: nullable(
        obj({
          stacks: arr(oneOf('incus', 'libvirt', 'proxmox')),
          kvm_enabled: bool,
          host_threads: num,
          vcpu_allocated: num,
          vcpu_overcommit_ratio: num,
          guest_memory_assigned_gb: num,
          guest_memory_assigned_pct: num,
          vms: num,
          containers: num,
        }),
      ),
      detail_view: oneOf('standard', 'proxmox'),
    }),
  ),
  alerts: arr(alertSchema),
  top_guests_by_cpu: record(arr(obj({ name: str, server: str, cpu_pct: num }))),
  platform_summary: obj({
    docker: obj({ running: num, stopped: num, unhealthy: num }),
    incus: obj({ containers_running: num, vms_running: num, stopped: num }),
    qemu: obj({ running: num, stopped: num, proxmox_vms_running: num, libvirt_vms_running: num }),
  }),
  agents_connected: opt(num),
  pending_enrollments: opt(num),
  hints: opt(arr(hintSchema)),
});

const pair = obj({ step_s: num, cpu_pct: series, mem_pct: series });
export const fleetSeriesSchema = obj({
  range: oneOf('1h', '6h', '24h', '7d', '30d', '90d'),
  as_of: str,
  kpi: pair,
  servers: record(pair),
  heatmap: obj({ buckets: num, bucket_s: num, cpu_pct: record(series) }),
});

export const guestSchema = obj({
  id: str,
  name: str,
  platform: oneOf('docker', 'incus', 'libvirt', 'pve'),
  kind: oneOf('vm', 'container'),
  image: str,
  state: oneOf('running', 'stopped', 'unhealthy', 'paused'),
  vcpu: opt(num),
  cpu_pct: numOrNull,
  memory_used_mb: numOrNull,
  memory_limit_mb: numOrNull,
  disk_read_mbs: opt(num),
  disk_write_mbs: opt(num),
  net_rx_mbps: opt(num),
  net_tx_mbps: opt(num),
  snapshots: opt(num),
  uptime_s: numOrNull,
  last_exit: opt(str),
  console: obj({
    available: bool,
    protocols: opt(arr(oneOf('vnc', 'spice', 'serial', 'shell', 'tty', 'logs'))),
    default_protocol: opt(oneOf('vnc', 'spice', 'serial', 'shell', 'tty', 'logs')),
    resolution: opt(str),
    unavailable: opt(record(str)),
  }),
  vmid: opt(num),
  node: opt(str),
  last_backup: opt(obj({ result: str, at: str })),
});

export const guestListSchema = obj({
  guests: arr(
    obj({
      server: str,
      server_online: opt(bool),
      id: str,
      name: str,
      platform: oneOf('docker', 'incus', 'libvirt', 'pve'),
      kind: oneOf('vm', 'container'),
      state: oneOf('running', 'stopped', 'unhealthy', 'paused'),
      cpu_pct: opt(num),
      memory_used_mb: opt(num),
      memory_limit_mb: opt(num),
      uptime_s: opt(num),
    }),
  ),
  total: num,
  next_cursor: opt(str),
  counts: opt(obj({ all: num, running: num, stopped: num, unhealthy: num })),
  platforms: opt(record(num)),
});

const workload = obj({
  running: num,
  total: num,
  cpu_pct: numOrNull,
  memory_gb: numOrNull,
  guests_shown: opt(num),
  containers: opt(num),
  vms: opt(num),
  guests: arr(guestSchema),
});

const smart = opt(obj({ passed: opt(bool), reallocated: opt(num), pending: opt(num), uncorrectable: opt(num) }));

const common = {
  as_of: str,
  server: obj({
    id: str,
    group: str,
    status,
    status_note: nullable(str),
    roles: arr(str),
    os: obj({ name: str, version: str, kernel: str }),
    cpu,
    memory: obj({ total_gb: num, type: nullable(str) }),
    uptime_s: numOrNull,
    last_boot: nullable(str),
    address: nullable(str),
    location: nullable(str),
    agent: obj({ version: str, last_sync_s_ago: numOrNull, connected: opt(bool), clock_skew_s: opt(num) }),
    detail_view: opt(oneOf('standard', 'proxmox')),
    remote_control: opt(obj({ console: bool, power: bool })),
    collectors: opt(arr(obj({ name: str, ok: bool }))),
  }),
  live: obj({
    refresh_interval_s: num,
    cpu_pct: numOrNull,
    cpu_user_pct: numOrNull,
    cpu_system_pct: numOrNull,
    cpu_iowait_pct: numOrNull,
    load_avg: nullable(arr(num)),
    mem_pct: numOrNull,
    mem_used_gb: numOrNull,
    mem_cache_gb: opt(num),
    zfs_arc_gb: opt(num),
    mem_free_gb: numOrNull,
    swap_used_gb: numOrNull,
    swap_total_gb: numOrNull,
  }),
  banner: nullable(obj({ severity, title: str, detail: str, link: nullable(str) })),
  sensors: arr(obj({ id: str, label: str, source: str, now_c: numOrNull, max_24h_c: numOrNull, limit_c: numOrNull })),
  virtualization: nullable(
    obj({
      stacks: arr(oneOf('incus', 'libvirt', 'proxmox')),
      capabilities: obj({
        kvm: obj({ enabled: bool }),
        cpu_virtualization: obj({ nested_paging: bool }),
        iommu: obj({ enabled: bool }),
        nested: obj({ enabled: bool }),
      }),
      allocation: obj({ vcpu_allocated: num, host_threads: num, guest_memory_assigned_gb: num, host_memory_gb: num }),
    }),
  ),
};

export const standardDetailSchema = obj({
  ...common,
  disks: arr(
    obj({
      device: str,
      type: oneOf('nvme', 'hdd', 'ssd'),
      model: str,
      role: str,
      capacity_gb: num,
      used_gb: num,
      wear_pct: numOrNull,
      written_tb: opt(num),
      rated_tbw: opt(num),
      temp_c: numOrNull,
      power_on_hours: numOrNull,
      health: oneOf('healthy', 'wear_high', 'failing'),
      smart,
    }),
  ),
  workloads: opt(obj({ docker: opt(workload), incus: opt(workload), libvirt: opt(workload) })),
});

export const proxmoxDetailSchema = obj({
  ...common,
  disks: arr(obj({ device: str, model: str, pool: str, wear_pct: numOrNull, temp_c: numOrNull, smart })),
  cluster: nullable(
    obj({
      name: str,
      quorate: bool,
      votes: obj({ have: num, expected: num }),
      ha: obj({ resources_started: num }),
      nodes: arr(
        obj({ name: str, this_node: bool, status: str, cpu_pct: numOrNull, mem_pct: numOrNull, vms: num, containers: num, agent: oneOf('connected', 'offline', 'not_enrolled') }),
      ),
      note: nullable(str),
    }),
  ),
  storages: arr(obj({ id: str, type: str, content: str, used_gb: num, capacity_gb: num })),
  backups: nullable(obj({ next_run: nullable(str), target: nullable(str) })),
  guests: obj({ vm: opt(workload), container: opt(workload) }),
});

export const metricsSchema = obj({
  server: str,
  range: oneOf('1h', '6h', '24h', '7d', '30d', '90d', 'custom'),
  step_seconds: num,
  points: num,
  as_of: str,
  timestamps: arr(str),
  series: record(series),
  summary: opt(record(nullable(obj({ avg: numOrNull, max: numOrNull, max_at: nullable(str) })))),
});

/** Returns the list of mismatches (empty when the value fits the schema). */
export function validate(schema: Check, value: unknown, root = '$'): string[] {
  const errs: string[] = [];
  schema(value, root, errs);
  return errs;
}
