// TypeScript types for the hub API (`/api/v1`).
//
// Base shapes: docs/handoff/docs/API.md and the fixtures in
// docs/handoff/sample-data/. Rackoon additions: docs/CONTRACT.md. Every
// CONTRACT addition is optional here: a fixture without it must still render.
//
// Pure types only (no runtime code) so the fixture dev server can import them.

export type Range = '1h' | '6h' | '24h' | '7d' | '30d' | '90d';
export const RANGES: readonly Range[] = ['1h', '6h', '24h', '7d', '30d', '90d'];

export type ServerStatus = 'online' | 'warning' | 'offline';
export type Severity = 'critical' | 'warning';
export type GuestState = 'running' | 'stopped' | 'unhealthy' | 'paused';
export type Platform = 'docker' | 'incus' | 'libvirt' | 'pve';
export type Stack = 'incus' | 'libvirt' | 'proxmox';
export type GuestKind = 'vm' | 'container';
export type DiskType = 'nvme' | 'hdd' | 'ssd';
export type DiskHealth = 'healthy' | 'wear_high' | 'failing';
/** logs: read-only (Docker container logs, the host's journal). */
export type ConsoleProtocol = 'vnc' | 'spice' | 'serial' | 'shell' | 'tty' | 'logs';
export type DetailView = 'standard' | 'proxmox';

/** RFC 9457 problem details (`application/problem+json`). */
export interface Problem {
  type?: string;
  title: string;
  status: number;
  detail?: string;
  code?: string;
  /** Manage endpoints: key -> message for the form field that failed (docs/MANAGE.md). */
  field_errors?: Record<string, string>;
}

// ---------------------------------------------------------------- /fleet

export interface FleetGroup {
  name: string;
  count: number;
}

export interface FleetKpis {
  servers_online: number;
  servers_total: number;
  cpu_avg_pct: number | null;
  memory_pct: number | null;
  memory_used_gb: number;
  memory_total_gb: number;
  storage_used_tb: number;
  storage_total_tb: number;
  storage_pct: number | null;
  disks_over_75_wear: number;
  open_alerts: number;
  open_alerts_critical: number;
  open_alerts_warning: number;
  /** Hub: open alerts not acknowledged, muted or suppressed. */
  open_alerts_attention?: number;
}

export interface CpuInfo {
  model: string;
  cores: number;
  threads: number;
}

export interface CurrentValues {
  cpu_pct: number | null;
  mem_pct: number | null;
  /** CONTRACT: may be null for hosts without sensors. */
  temp_max_c: number | null;
  /** CONTRACT: limit of the hottest sensor. Missing -> 85. */
  temp_limit_c?: number | null;
  disk_used_pct: number | null;
  disk_wear_max_pct: number | null;
}

export interface LastKnownValues {
  cpu_pct?: number | null;
  mem_pct?: number | null;
  temp_max_c?: number | null;
  disk_used_pct?: number | null;
  disk_wear_max_pct?: number | null;
}

export interface ServerWorkloadCounts {
  docker: { running: number; stopped: number; unhealthy: number };
  incus: { containers_running: number; vms_running: number; stopped: number };
  qemu: { running: number; stopped: number };
}

export interface FleetHypervisor {
  stacks: Stack[];
  kvm_enabled: boolean;
  host_threads: number;
  vcpu_allocated: number;
  vcpu_overcommit_ratio: number;
  guest_memory_assigned_gb: number;
  guest_memory_assigned_pct: number;
  vms: number;
  containers: number;
}

export interface FleetServer {
  id: string;
  group: string;
  status: ServerStatus;
  status_note: string | null;
  /** CONTRACT 7.1: os, cpu, memory, storage and last_seen are null for a server whose agent never reported. */
  os: string | null;
  cpu: CpuInfo | null;
  memory_total_gb: number | null;
  storage_capacity_tb: number | null;
  last_seen: string | null;
  current: CurrentValues | null;
  last_known: LastKnownValues | null;
  workloads: ServerWorkloadCounts;
  hypervisor: FleetHypervisor | null;
  detail_view: DetailView;
  /** Hub addition: consoles are on in the hub and in the agent (fixtures: absent). */
  console_on?: boolean;
  /** The maintenance window muting this host's alerts now. */
  maintenance?: MaintenanceInfo | null;
  /** The enrolled host this one runs on. */
  parent?: string | null;
}

export interface MaintenanceInfo {
  id: string;
  until: string;
  note: string;
}

export interface AlertAck {
  at: string;
  by: string;
  note: string;
  /** A snooze: the acknowledgement lapses then. */
  until: string | null;
}

export interface Alert {
  id: string;
  server: string;
  severity: Severity;
  title: string;
  detail: string;
  opened_at: string;
  rule: string;
  /** API.md 6 additions (real API only). */
  resolved_at?: string | null;
  state?: 'open' | 'resolved';
  /** Section of the host page the alert concerns ("#storage"), or null. */
  link?: string | null;
  acknowledged?: AlertAck | null;
  /** The host is in maintenance: no notifications, not in the badge. */
  muted?: boolean;
  /** The host it runs on is offline (the cause). */
  suppressed_by?: string | null;
  /** Open and none of the above: counts in the badge. Missing (fixtures): true while open. */
  attention?: boolean;
}

/** An alert asks for attention (badge, banner, notifications). */
export function needsAttention(a: Alert): boolean {
  if (a.attention !== undefined) return a.attention;
  return a.state !== 'resolved' && !a.acknowledged && !a.muted && !a.suppressed_by;
}

export interface Maintenance {
  id: string;
  scope: 'server' | 'group' | 'all';
  target: string;
  starts_at: string;
  ends_at: string | null;
  /** Weekly windows: 0 = Sunday. Empty for one-off windows. */
  weekdays: number[];
  start_time: string;
  duration_min: number;
  tz: string;
  note: string;
  created_by: string;
  created_at: string;
  active: boolean;
  active_until: string | null;
  next_start: string | null;
}

export interface MaintenanceCreate {
  scope: Maintenance['scope'];
  target?: string;
  starts_at?: string;
  ends_at?: string;
  duration_min?: number;
  weekdays?: number[];
  start_time?: string;
  tz?: string;
  note?: string;
}

export interface TopGuest {
  name: string;
  server: string;
  cpu_pct: number;
}

export interface PlatformSummary {
  docker: { running: number; stopped: number; unhealthy: number };
  incus: { containers_running: number; vms_running: number; stopped: number };
  qemu: { running: number; stopped: number; proxmox_vms_running: number; libvirt_vms_running: number };
}

export interface Fleet {
  as_of: string;
  groups: FleetGroup[];
  kpis: FleetKpis;
  servers: FleetServer[];
  alerts: Alert[];
  top_guests_by_cpu: { docker: TopGuest[]; incus: TopGuest[]; qemu: TopGuest[] };
  platform_summary: PlatformSummary;
  /** CONTRACT: missing -> count servers with status != offline. */
  agents_connected?: number;
  /** CONTRACT: missing -> 0. */
  pending_enrollments?: number;
  /** CONTRACT 1 (hints): conditions worth watching for the selected group. Missing -> []. */
  hints?: Hint[];
}

// ---------------------------------------------------------------- hints (CONTRACT 1)

export type HintSeverity = 'warning' | 'info';

/** A condition worth watching that is not (yet) an alert, computed by the hub from the latest report. */
export interface Hint {
  server: string;
  /** sensor.near_limit | swap.high | memory.low | disk.space | disk.wear | collector.error | guests.unhealthy | agent.outdated */
  kind: string;
  severity: HintSeverity;
  entity: string;
  title: string;
  detail: string;
  /** "#temps", "#storage", "#virtualization", "#guests", "#agent" or "". */
  link: string;
}

// ---------------------------------------------------------------- /fleet/series

export type SeriesValues = (number | null)[];

export interface SeriesPair {
  step_s: number;
  cpu_pct: SeriesValues;
  mem_pct: SeriesValues;
  /** Per server, when stored: network in + out (Mb/s) and the hottest sensor. */
  net_mbps?: SeriesValues;
  temp_max_c?: SeriesValues;
}

export interface FleetSeries {
  range: Range;
  as_of: string;
  kpi: SeriesPair;
  servers: Record<string, SeriesPair>;
  heatmap: {
    buckets: number;
    bucket_s: number;
    cpu_pct: Record<string, SeriesValues>;
  };
}

// ---------------------------------------------------------------- /servers

/**
 * Light server list for the top bar's server menu. Not specified in
 * API.md beyond "derived from fleet.json > servers[]"; the client accepts a
 * bare array or `{servers: [...]}` / `{items: [...]}`.
 */
export interface ServerListItem {
  id: string;
  group: string;
  status: ServerStatus;
  status_note?: string | null;
  os?: string | null;
  detail_view?: DetailView;
  /** Hub: the caller's permissions on this server. */
  remote_control?: RemoteControl;
}

// ---------------------------------------------------------------- /servers/{id}

export interface RemoteControl {
  console: boolean;
  power: boolean;
  agent_console?: boolean;
  agent_power?: boolean;
  console_reason?: string | null;
  power_reason?: string | null;
  /** The host itself (admins, its own switches; off by default). */
  host_shell?: boolean;
  host_power?: boolean;
  agent_host_shell?: boolean;
  agent_host_power?: boolean;
  host_shell_reason?: string | null;
  host_power_reason?: string | null;
  /** Guest configuration and lifecycle (Proxmox VE, Incus; docs/MANAGE.md). */
  manage?: boolean;
  agent_manage?: boolean;
  manage_reason?: string | null;
  /** Read-only checks the assistant runs (docs/ASSIST.md 2; on by default, both sides). */
  diagnose?: boolean;
  agent_diagnose?: boolean;
  diagnose_reason?: string | null;
}

export interface CollectorStatus {
  name: string;
  ok: boolean;
  error?: string | null;
}

export interface ServerInfo {
  id: string;
  group: string;
  status: ServerStatus;
  status_note: string | null;
  roles: string[];
  os: { name: string; version: string; kernel: string };
  cpu: CpuInfo;
  memory: { total_gb: number; type: string | null };
  uptime_s: number | null;
  last_boot: string | null;
  address: string | null;
  location: string | null;
  agent: {
    version: string;
    last_sync_s_ago: number | null;
    /** CONTRACT */
    connected?: boolean;
    /** CONTRACT */
    clock_skew_s?: number | null;
  };
  /** API.md says it is here; the fixtures omit it (see isProxmoxDetail). */
  detail_view?: DetailView;
  /** CONTRACT: missing -> {console: true, power: true}. */
  remote_control?: RemoteControl;
  /** CONTRACT */
  collectors?: CollectorStatus[];
  maintenance?: MaintenanceInfo | null;
  parent?: string | null;
}

export interface LiveValues {
  refresh_interval_s: number;
  cpu_pct: number | null;
  cpu_user_pct: number | null;
  cpu_system_pct: number | null;
  cpu_iowait_pct: number | null;
  load_avg: number[] | null;
  mem_pct: number | null;
  mem_used_gb: number | null;
  /** Standard hosts. */
  mem_cache_gb?: number | null;
  /** Proxmox hosts (instead of mem_cache_gb). */
  zfs_arc_gb?: number | null;
  mem_free_gb: number | null;
  swap_used_gb: number | null;
  swap_total_gb: number | null;
}

export interface Banner {
  severity: Severity;
  title: string;
  detail: string;
  link: string | null;
}

export interface Sensor {
  id: string;
  label: string;
  group?: string;
  source: string;
  now_c: number | null;
  /** Max over the requested range despite the name (API.md 2.3). */
  max_24h_c: number | null;
  limit_c: number | null;
}

export interface SmartCounters {
  passed?: boolean | null;
  reallocated?: number | null;
  pending?: number | null;
  uncorrectable?: number | null;
  /** Host health additions (CONTRACT "Host health"). */
  self_test?: { type: string; result: string; poh?: number } | null;
  error_log?: number | null;
  crc_errors?: number | null;
  critical_warning?: number | null;
  spare_pct?: number | null;
  spare_threshold?: number | null;
  media_errors?: number | null;
  unsafe_shutdowns?: number | null;
  standby?: boolean;
}

export interface DiskIO {
  read_mbs: number;
  write_mbs: number;
  util_pct: number;
  await_ms: number;
}

export interface Disk {
  device: string;
  type: DiskType;
  model: string;
  role: string;
  capacity_gb: number;
  used_gb: number;
  wear_pct: number | null;
  written_tb?: number | null;
  rated_tbw?: number | null;
  temp_c: number | null;
  power_on_hours: number | null;
  health: DiskHealth;
  /** Why the disk counts as failing. */
  health_reason?: string | null;
  /** CONTRACT */
  smart?: SmartCounters;
  io?: DiskIO | null;
}

export interface ProxmoxDisk {
  device: string;
  model: string;
  pool: string;
  wear_pct: number | null;
  temp_c: number | null;
  /** Optional extras (not in the fixture). */
  capacity_gb?: number | null;
  smart?: SmartCounters;
  health?: DiskHealth;
  health_reason?: string | null;
  io?: DiskIO | null;
}

export interface VirtualizationCapabilities {
  kvm: { enabled: boolean; module: string | null; device: string | null };
  cpu_virtualization: { type: string | null; flag: string | null; nested_paging: boolean };
  iommu: { enabled: boolean; groups: number | null; vfio_pci_devices: number | null };
  nested: { enabled: boolean; module_param: string | null };
  hugepages?: { reserved_gb: number; page_size: string; count: number } | null;
  ksm?: { saved_gb: number } | null;
  ballooning?: { state: string; vms_active?: number; vms_total?: number } | null;
}

export interface Allocation {
  vcpu_allocated: number;
  host_threads: number;
  vcpu_overcommit_ratio: number;
  guest_memory_assigned_gb: number;
  host_memory_gb: number;
  guest_memory_in_use_gb: number | null;
  disk_io_mbs: { total: number; read: number; write: number } | null;
  network_mbps: { total: number; rx: number; tx: number } | null;
}

export interface Virtualization {
  stacks: Stack[];
  capabilities: VirtualizationCapabilities;
  allocation: Allocation;
}

export interface GuestConsole {
  available: boolean;
  protocols?: ConsoleProtocol[];
  default_protocol?: ConsoleProtocol;
  resolution?: string | null;
  /** CONTRACT: protocols the platform has but Rackoon cannot serve. */
  unavailable?: Partial<Record<ConsoleProtocol, string>>;
}

export interface Guest {
  id: string;
  name: string;
  platform: Platform;
  kind: GuestKind;
  image: string;
  state: GuestState;
  vcpu?: number | null;
  cpu_pct: number | null;
  memory_used_mb: number | null;
  memory_limit_mb: number | null;
  disk_read_mbs?: number | null;
  disk_write_mbs?: number | null;
  net_rx_mbps?: number | null;
  net_tx_mbps?: number | null;
  snapshots?: number | null;
  uptime_s: number | null;
  /** Docker only, e.g. "6 h ago". */
  last_exit?: string | null;
  console: GuestConsole;
  /** Proxmox only. */
  vmid?: number;
  node?: string;
  last_backup?: { result: string; at: string } | null;
  /** Optional, when the platform reports them. */
  addresses?: string[];
  lock?: string;
  restarts?: number;
  exit_code?: number;
  oom_killed?: boolean;
  project?: string;
  update_available?: boolean;
  disk_used_gb?: number;
  processes?: number;
  /** Proxmox: tags, configuration changes waiting for a restart, QEMU guest agent state, oldest snapshot, backup job coverage, HA state. */
  tags?: string[];
  pending_changes?: number;
  guest_agent?: 'running' | 'not_running' | null;
  oldest_snapshot?: string | null;
  backup_job?: boolean | null;
  ha_state?: string | null;
}

export interface PlatformWorkload {
  running: number;
  total: number;
  cpu_pct: number | null;
  memory_gb: number | null;
  guests_shown?: number;
  /** Incus: running containers / VMs. */
  containers?: number;
  vms?: number;
  guests: Guest[];
  paused?: number;
  warnings?: PlatformWarning[];
}

export interface PlatformWarning {
  type: string;
  message: string;
  count: number;
  last_seen: string | null;
  project: string | null;
}

export interface StandardWorkloads {
  docker?: PlatformWorkload;
  incus?: PlatformWorkload;
  libvirt?: PlatformWorkload;
}

export interface ClusterNode {
  name: string;
  this_node: boolean;
  status: string;
  cpu_pct: number | null;
  mem_pct: number | null;
  vms: number;
  containers: number;
  agent: 'connected' | 'offline' | 'not_enrolled';
  /** The enrolled server of this node (null: none). */
  server_id?: string | null;
}

export interface Cluster {
  name: string;
  quorate: boolean;
  votes: { have: number; expected: number };
  ha: { resources_started: number };
  nodes: ClusterNode[];
  note: string | null;
}

export interface ProxmoxStorage {
  id: string;
  type: string;
  content: string;
  used_gb: number;
  capacity_gb: number;
}

export interface Backups {
  last_job: {
    at: string;
    schedule: string;
    mode: string;
    result: string;
    guests_ok: number;
    guests_total: number;
    warnings: number;
    written_gb: number;
    dedup_ratio: number | null;
    duration_min: number;
    avg_duration_min_week: number | null;
  } | null;
  next_run: string | null;
  target: string | null;
}

// ---------------------------------------------------------------- host health

export interface HostSystem {
  package_manager: string | null;
  /** null: unknown. */
  updates: number | null;
  security_updates: number | null;
  updates_checked_at: string | null;
  updates_error: string | null;
  reboot_required: boolean;
  reboot_reason: string | null;
  init_system: string | null;
  failed_count: number;
  failed_units: string[];
  time_synced: boolean | null;
  time_offset_ms: number | null;
  time_source: string | null;
  oom_kills: number;
  processes: number;
  steal_pct: number | null;
  /** PSI avg10, percent. */
  pressure: { cpu: number; memory: number; memory_full: number; io: number; io_full: number } | null;
}

export interface NetIface {
  name: string;
  kind: string;
  up: boolean;
  carrier: boolean;
  speed_mbps: number | null;
  mtu: number | null;
  addresses: string[];
  master: string | null;
  members: string[];
  rx_mbps: number;
  tx_mbps: number;
  errors: number;
  drops: number;
}

export interface Volume {
  entity: string;
  kind: 'fs' | 'pool' | 'storage';
  label: string;
  used_gb: number;
  total_gb: number;
  used_pct: number;
  /** Growth forecast; null: not filling up. */
  full_in_days: number | null;
  fs_type?: string | null;
  device?: string | null;
  inodes_pct?: number | null;
  read_only?: boolean;
  remote?: boolean;
  error?: string | null;
  health?: string | null;
  layout?: string | null;
  scrub?: { state: string; end: string | null; errors: number } | null;
  errors?: { read: number; write: number; checksum: number } | null;
  frag_pct?: number | null;
  faulted?: string[];
  status?: string | null;
}

export interface RaidArray {
  name: string;
  level: string;
  state: string;
  devices: number;
  active: number;
  members: string[];
  failed: string[];
  sync_pct: number | null;
  size_gb: number | null;
  last_check: string | null;
  check_errors: number | null;
}

export interface Ups {
  name: string;
  model: string | null;
  status: string;
  charge_pct: number | null;
  runtime_s: number | null;
  load_pct: number | null;
}

export interface Gpu {
  index: number;
  name: string;
  vendor: string;
  util_pct: number | null;
  mem_used_gb: number | null;
  mem_total_gb: number | null;
  temp_c: number | null;
  power_w: number | null;
}

export interface Fan {
  label: string;
  source: string;
  rpm: number;
  min_rpm: number | null;
}

export interface PveTask {
  /** pve (a Proxmox task) or incus (a failed operation). */
  platform?: string;
  type: string;
  id: string | null;
  node: string;
  user: string | null;
  start: string;
  end: string | null;
  status: string;
  ok: boolean;
}

export interface PveReplication {
  id: string;
  guest: string;
  target: string;
  last_sync: string | null;
  error: string | null;
  fails: number;
}

/** Host health parts of the detail; missing on older hubs. */
export interface HostHealth {
  system?: HostSystem | null;
  network?: NetIface[];
  volumes?: Volume[];
  arrays?: RaidArray[];
  ups?: Ups[];
  gpus?: Gpu[];
  fans?: Fan[];
  /** Failed (and running Proxmox) tasks of the last 48 h. */
  tasks?: PveTask[];
  pve_replication?: PveReplication[];
  ceph?: { status: string; summary: string[] } | null;
}

interface DetailCommon extends HostHealth {
  as_of: string;
  server: ServerInfo;
  live: LiveValues;
  banner: Banner | null;
  sensors: Sensor[];
  /** CONTRACT: null for hosts without KVM. */
  virtualization: Virtualization | null;
  /** CONTRACT 1 (hints) for this host. Missing -> []. */
  hints?: Hint[];
}

export interface StandardDetail extends DetailCommon {
  disks: Disk[];
  workloads?: StandardWorkloads;
}

export interface ProxmoxDetail extends DetailCommon {
  disks: ProxmoxDisk[];
  cluster: Cluster | null;
  storages: ProxmoxStorage[];
  backups: Backups | null;
  guests: { vm?: PlatformWorkload; container?: PlatformWorkload };
}

export type ServerDetail = StandardDetail | ProxmoxDetail;

// ---------------------------------------------------------------- /servers/{id}/guests

/** Response of `GET /servers/{id}/guests?platform=&kind=` (shape assumed, see client). */
export interface GuestList {
  guests: Guest[];
  total?: number;
  next_cursor?: string | null;
}

// ---------------------------------------------------------------- /guests (CONTRACT 1)

/** A guest of the fleet-wide list: the guest object plus the server it runs on. */
export interface FleetGuest extends Guest {
  server: string;
  /** False when the server is offline (the guest comes from its last report). */
  server_online: boolean;
}

export interface GuestListParams {
  q?: string;
  state?: GuestState | '';
  platform?: Platform | '';
  kind?: GuestKind | '';
  server?: string;
  /** Proxmox tag (exact, case-insensitive). */
  tag?: string;
  /** cpu (default) | memory | name | state | server, optional "-" / "+" prefix. */
  sort?: string;
  limit?: number;
  cursor?: string | null;
}

export interface GuestListPage {
  guests: FleetGuest[];
  /** After every filter. */
  total: number;
  next_cursor: string | null;
  /** Over the guests matching `q` and `server`, before the state / platform / kind filters. */
  counts: { all: number; running: number; stopped: number; unhealthy: number };
  platforms: Partial<Record<Platform, number>>;
  /** Proxmox tags over the same guests as `counts`, tag -> guests. */
  tags?: Record<string, number>;
}

/** @deprecated kept for the fixture tests; the list shape is a superset. */
export type GuestHit = Pick<FleetGuest, 'server' | 'id' | 'name' | 'platform' | 'kind' | 'state'>;
export type GuestSearch = GuestListPage;

// ---------------------------------------------------------------- /servers/{id}/metrics

export interface MetricSummary {
  avg: number | null;
  max: number | null;
  max_at: string | null;
}

export interface Metrics {
  server: string;
  /** "custom" for a from/to window. */
  range: Range | 'custom';
  step_seconds: number;
  points: number;
  as_of: string;
  timestamps: string[];
  series: Record<string, SeriesValues>;
  /** CONTRACT: per returned series; null when there is no data. */
  summary?: Record<string, MetricSummary | null>;
}

/** A from/to window (ISO times) zoomed into on the host charts. */
export interface Zoom {
  from: string;
  to: string;
}

/** Chart marker (GET /servers/{id}/annotations). */
export interface Annotation {
  at: string;
  kind: 'alert' | 'reboot' | 'action' | 'agent';
  severity?: Severity;
  text: string;
}

// ---------------------------------------------------------------- /auth

export type Role = 'viewer' | 'operator' | 'admin';

export interface AuthState extends AuthStateExtra {
  setup_required: boolean;
  authenticated: boolean;
  user: { name: string; role: Role } | null;
  passkeys?: number;
  /** Also issued before sign-in (login and setup need it). */
  csrf_token?: string | null;
}

export interface AuthStateExtra {
  /** Hub: false when WebAuthn is not configured (no https public URL). Missing -> true. */
  passkeys_available?: boolean;
  /** A read-only session opened from a kiosk link: no settings, no actions. */
  kiosk?: boolean;
  /** False for accounts that sign in with single sign-on only. */
  has_password?: boolean;
  /** local | oidc */
  source?: string;
  /** Single sign-on is configured: the login page offers "Sign in with <name>". */
  oidc?: { name: string } | null;
  /** The password is a temporary one: choose a new one before anything else. */
  password_change_required?: boolean;
}

export interface Passkey {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

// ---------------------------------------------------------------- console (CONTRACT 4)

export interface ConsoleSession {
  session_id: string;
  /** Relative to the UI origin ("/api/v1/console/cs_…"); converted to ws(s)://. */
  url: string;
  token: string;
  protocol: ConsoleProtocol;
  expires_at: string;
  idle_timeout_s: number;
  requires_confirmation?: boolean;
}

export type PowerAction = 'start' | 'shutdown' | 'reboot' | 'force_stop' | 'restart' | 'stop' | 'pause' | 'resume';
export type SnapshotAction = 'snapshot_create' | 'snapshot_restore' | 'snapshot_delete';
export type HostAction = 'host_reboot' | 'host_shutdown';
/** Any action of POST .../actions. */
export type GuestAction = PowerAction | SnapshotAction | HostAction;

/** Extra fields of a snapshot action. */
export interface SnapshotArgs {
  snapshot?: string;
  description?: string;
  /** Include the VM's memory state (Proxmox and libvirt VMs). */
  memory?: boolean;
}

export interface ActionAccepted {
  action_id: string;
  audit_id: string;
  /** API.md: already in the requested state. */
  noop?: boolean;
}

/** SSE `action.finished`. */
export interface ActionFinished {
  action_id: string;
  server?: string;
  guest?: string;
  action?: string;
  result: 'ok' | 'error';
  message?: string | null;
  state?: GuestState | null;
  /** Error code (e.g. "timeout": still running on the host). */
  code?: string | null;
  noop?: boolean;
}

// ---------------------------------------------------------------- admin (CONTRACT 3)

export interface Enrollment {
  id: string;
  token: string;
  expires_at: string;
  install_command: string;
}

export interface PendingEnrollment {
  id: string;
  hostname: string | null;
  os: string | null;
  address: string | null;
  agent_version: string | null;
  requested_at: string | null;
  /** Hub extras. */
  state?: string;
  expires_at?: string;
  server_id?: string | null;
}

export interface RemoteControlToggles {
  console: boolean;
  power: boolean;
  /** Root shell on the host (off by default; needs host_shell in agent.toml too). */
  host_shell?: boolean;
  /** Reboot / shut down the host. */
  host_power?: boolean;
  /** Guest configuration and lifecycle (Proxmox VE, Incus). */
  manage?: boolean;
  /** Read-only checks the assistant runs (on by default; docs/ASSIST.md). */
  diagnose?: boolean;
}

export interface ServerSettings {
  id: string;
  group: string;
  location: string | null;
  remote_control: RemoteControlToggles;
  agent_policy: RemoteControlToggles;
  /** "" = detected automatically, "-" = none, else a server id. */
  parent?: string;
  detected_parent?: string | null;
}

export interface ServerSettingsPatch {
  group?: string;
  location?: string;
  parent?: string;
  remote_control?: Partial<RemoteControlToggles>;
}

export interface AgentInfo {
  server_id: string;
  hostname: string;
  version: string | null;
  connected: boolean;
  last_seen: string | null;
  address: string | null;
  clock_skew_s: number | null;
  collectors: CollectorStatus[];
  remote_control: RemoteControlToggles;
  agent_policy: RemoteControlToggles;
  /** Hub extras (optional). */
  status?: ServerStatus;
  group?: string;
  location?: string | null;
  cert_expires_at?: string | null;
  /** Self-update to the hub's agent build. */
  update?: AgentUpdateInfo;
  arch?: string;
  /** How the agent was installed: systemd | openrc | sysv | unraid | manual. */
  install?: string | null;
}

export interface AgentUpdateInfo {
  available: boolean;
  /** The hub's agent build; missing when the hub has none. */
  version?: string;
  /** Why not (also "Up to date."). */
  reason?: string;
  /** Last rollout outcome for this agent. */
  state?: 'updating' | 'failed';
  message?: string;
}

export type AuditOutcome = 'ok' | 'denied' | 'error';

export interface AuditRecord {
  id: string;
  at: string;
  user: string | null;
  role: string | null;
  client_ip: string | null;
  user_agent: string | null;
  server: string | null;
  guest: string | null;
  platform: string | null;
  event: string;
  protocol: string | null;
  outcome: AuditOutcome;
  code: string | null;
  duration_s: number | null;
  bytes_in: number | null;
  bytes_out: number | null;
  details?: Record<string, string> | null;
}

export interface AuditPage {
  items: AuditRecord[];
  next_cursor: string | null;
}

// ---------------------------------------------------------------- notifications (admin)

export type ChannelKind = 'ntfy' | 'webhook' | 'shoutrrr';

export interface Delivery {
  id: number;
  channel: string;
  at: string;
  kind: 'opened' | 'resolved' | 'reminder' | 'test' | 'heartbeat';
  alert_ids: string[];
  summary: string;
  ok: boolean;
  error: string;
  attempt: number;
}

export interface Channel {
  id: string;
  name: string;
  kind: ChannelKind;
  /** The destination without secrets. */
  target: string;
  min_severity: 'warning' | 'critical';
  groups: string[];
  send_resolved: boolean;
  reminder_min: number;
  enabled: boolean;
  format?: string;
  header_names: string[];
  has_token: boolean;
  created_by: string;
  created_at: string;
  last_delivery: Delivery | null;
}

export interface ChannelInput {
  name?: string;
  kind?: ChannelKind;
  url?: string;
  min_severity?: 'warning' | 'critical';
  groups?: string[];
  send_resolved?: boolean;
  reminder_min?: number;
  enabled?: boolean;
  format?: string;
  headers?: Record<string, string>;
  token?: string;
}

export interface NotifySettings {
  /** The URL itself is write-only; the target is its scheme and host. */
  heartbeat_set: boolean;
  heartbeat_target: string;
  heartbeat_minutes: number;
  heartbeat_last: string | null;
  heartbeat_failing: boolean;
}

// ---------------------------------------------------------------- inspect (host views, snapshots)

export type InspectKind = 'processes' | 'services' | 'ports' | 'updates';

export interface InspectResult<T> {
  kind: string;
  as_of: string;
  /** The agent capped the list. */
  truncated: boolean;
  items: T[];
}

export interface HostProcess {
  pid: number;
  ppid?: number;
  user: string;
  name: string;
  command: string;
  cpu_pct: number;
  rss_bytes: number;
  /** R S D Z T I */
  state: string;
  threads?: number;
  /** "docker:web", "incus:dev", "pve:101". */
  container?: string;
  started?: string;
}

export interface HostPort {
  /** tcp | tcp6 | udp | udp6 */
  proto: string;
  address: string;
  port: number;
  pid?: number;
  process?: string;
}

export interface HostService {
  name: string;
  description?: string;
  load?: string;
  /** active | inactive | failed | activating */
  active: string;
  sub?: string;
  enabled?: string;
  since?: string;
}

export interface PackageUpdate {
  name: string;
  current?: string;
  new: string;
  security?: boolean;
  source?: string;
}

export interface Snapshot {
  name: string;
  created?: string;
  description?: string;
  parent?: string;
  memory?: boolean;
  current?: boolean;
  size_bytes?: number;
}

// ---------------------------------------------------------------- checks

export type CheckKind = 'http' | 'tcp' | 'ping' | 'dns' | 'heartbeat';
export type CheckStatus = 'up' | 'down' | 'pending' | 'disabled';

export interface CheckOptions {
  expect_status?: string;
  keyword?: string;
  tls?: boolean;
  insecure?: boolean;
  dns_type?: string;
  dns_server?: string;
  expect?: string;
  cert_warn_days?: number;
}

export interface CheckLast {
  at: string;
  ok: boolean;
  latency_ms: number | null;
  error?: string;
  status_code?: number;
  cert_not_after?: string;
  answer?: string[];
}

export interface Check {
  id: string;
  name: string;
  kind: CheckKind;
  target: string;
  /** "hub" or a server id. */
  runner: string;
  interval_s: number;
  timeout_s: number;
  grace_s: number;
  options: CheckOptions;
  enabled: boolean;
  status: CheckStatus;
  since: string | null;
  last: CheckLast | null;
  last_ping: string | null;
  /** Percent, 0 to 100. */
  uptime_24h: number | null;
  latency_24h: SeriesValues;
  /** Heartbeat checks, admins only. */
  ping_url: string | null;
  created_by: string;
}

export interface CheckInput {
  name?: string;
  kind?: CheckKind;
  target?: string;
  runner?: string;
  interval_s?: number;
  timeout_s?: number;
  grace_s?: number;
  options?: CheckOptions;
  enabled?: boolean;
}
