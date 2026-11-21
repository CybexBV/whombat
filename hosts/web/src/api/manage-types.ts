// Types of the "manage" endpoints (docs/MANAGE.md, docs/REST-API.md):
// guest configuration and lifecycle on Proxmox VE and Incus. Pure types,
// shared by the UI (api/manage.ts) and the fixture server.

export type ManagePlatform = 'pve' | 'incus';

/** A guest's configuration as the platform stores it (raw values). */
export interface GuestConfig {
  platform: ManagePlatform;
  kind: 'vm' | 'container';
  /** Send back with changes: a change made meanwhile fails with 409 digest_mismatch. */
  digest: string;
  lock?: string;
  running: boolean;
  /**
   * key -> raw value. PVE: property strings ("scsi0": "local-zfs:vm-100-disk-0,iothread=1,size=32G").
   * Incus: config keys and "device.<name>" -> "type=nic,network=incusbr0". Secrets read "**********".
   */
  values: Record<string, string>;
  /** key -> value that applies at the next restart. */
  pending?: Record<string, string>;
  /** Keys removed at the next restart. */
  pending_delete?: string[];
  /** Keys Rackoon shows but never changes (root-only settings). */
  restricted?: string[];
  /** Incus: keys whose value comes from a profile. */
  inherited?: string[];
  profiles?: string[];
  disks?: GuestDisk[];
  ha?: HAState | null;
  replication?: ReplicationJob[];
}

export interface GuestDisk {
  key: string;
  storage?: string;
  volume?: string;
  size_bytes?: number;
  media?: 'disk' | 'cdrom';
  path?: string;
  unused?: boolean;
  boot?: boolean;
}

export interface ConfigChange {
  key: string;
  old?: string;
  new?: string;
  /** Applies at the next restart. */
  pending?: boolean;
}

export interface ConfigPatch {
  digest?: string;
  set?: Record<string, string>;
  delete?: string[];
  revert?: string[];
  /** Required when the change destroys data (deleting an unused disk). */
  confirm?: boolean;
}

export interface TaskRef {
  id: string;
}

/** Answer of a change: done (changes) or still running on the host (task, HTTP 202). */
export interface ManageResult {
  ok: boolean;
  task?: TaskRef;
  /** create / clone / restore: the new guest's id ("pve:123"). */
  new_id?: string;
  changes?: ConfigChange[];
  audit_id?: string;
}

export interface ChoiceStorage {
  id: string;
  type: string;
  /** images | rootdir | iso | vztmpl | backup | import | snippets */
  content: string[];
  avail_bytes?: number;
  total_bytes?: number;
  shared?: boolean;
  thin?: boolean;
}

export interface StorageVolume {
  volume: string;
  storage: string;
  content: 'iso' | 'vztmpl' | 'import';
  name: string;
  size_bytes?: number;
  created?: string;
}

export interface TemplateGuest {
  id: string;
  name: string;
  kind: 'vm' | 'container';
  node?: string;
  disk_bytes?: number;
}

export interface IncusImage {
  fingerprint: string;
  aliases?: string[];
  description?: string;
  type: 'container' | 'virtual-machine';
  size_bytes?: number;
}

/** What the forms offer on a host. */
export interface Choices {
  platform: ManagePlatform;
  node?: string;
  cluster?: boolean;
  next_id?: number;
  storages: ChoiceStorage[];
  bridges: string[];
  isos?: StorageVolume[];
  ct_templates?: StorageVolume[];
  templates?: TemplateGuest[];
  cpu_types?: string[];
  /** Other cluster nodes (replication targets). */
  nodes?: string[];
  /** Downloads from a URL work on this host. */
  download?: boolean;
  profiles?: string[];
  images?: IncusImage[];
}

export interface BackupVolume {
  volume: string;
  storage: string;
  guest?: string;
  kind?: 'vm' | 'container';
  size_bytes?: number;
  created?: string;
  format?: string;
  notes?: string;
  protected?: boolean;
  encrypted?: boolean;
  /** Proxmox Backup Server verification. */
  verified?: 'ok' | 'failed' | '';
}

export interface Appliance {
  template: string;
  package?: string;
  headline?: string;
  description?: string;
  os?: string;
  version?: string;
  section?: string;
}

export type TaskState = 'running' | 'ok' | 'warning' | 'error';

export interface TaskStatus {
  id: string;
  type: string;
  guest?: string;
  user?: string;
  started: string;
  ended?: string | null;
  status: TaskState;
  message?: string;
  log?: string[];
  log_next?: number;
}

export interface FirewallRule {
  pos: number;
  type: 'in' | 'out' | 'group';
  action: string;
  enable: boolean;
  macro?: string;
  proto?: string;
  source?: string;
  dest?: string;
  sport?: string;
  dport?: string;
  iface?: string;
  log?: string;
  comment?: string;
}

export interface GuestFirewall {
  options: Record<string, string>;
  options_digest?: string;
  rules: FirewallRule[];
  rules_digest?: string;
  groups?: string[];
  cluster_enabled: boolean;
}

export interface HASettings {
  state: 'started' | 'stopped' | 'ignored' | 'disabled';
  max_restart?: number;
  max_relocate?: number;
  comment?: string;
}

export interface HAState extends HASettings {
  status?: string;
}

export interface ReplicationJob {
  id: string;
  target: string;
  schedule?: string;
  rate?: string;
  comment?: string;
  disabled?: boolean;
  last_sync?: string | null;
  error?: string;
}

export interface CreateGuestInput {
  platform: ManagePlatform;
  kind: 'vm' | 'container';
  /** PVE vmid (0 or missing: the next free one). */
  new_id?: number;
  name?: string;
  /** Platform config keys (PVE: memory, cores, scsi0 "local-zfs:32", net0, ide2, ostemplate, rootfs, ...). */
  set: Record<string, string>;
  start?: boolean;
  /** Incus: "images:debian/13", a local alias or fingerprint. */
  image?: string;
  profiles?: string[];
}

export interface CloneInput {
  new_id?: number;
  name?: string;
  full?: boolean;
  storage?: string;
}

export interface BackupInput {
  storage: string;
  mode?: 'snapshot' | 'suspend' | 'stop';
  compress?: 'zstd' | 'lzo' | 'gzip' | 'none';
  notes?: string;
  protected?: boolean;
}

export interface RestoreInput {
  platform: ManagePlatform;
  volume: string;
  /** Restore as a new guest with this id (0: next free) ... */
  new_id?: number;
  /** ... or over this existing guest ("pve:100"); its disks are replaced. */
  guest?: string;
  storage?: string;
  start?: boolean;
  unique?: boolean;
  confirm?: boolean;
}

export interface DownloadInput {
  platform: ManagePlatform;
  content: 'iso' | 'vztmpl' | 'import';
  url: string;
  filename: string;
  checksum?: string;
  checksum_algorithm?: 'md5' | 'sha1' | 'sha224' | 'sha256' | 'sha384' | 'sha512';
}
